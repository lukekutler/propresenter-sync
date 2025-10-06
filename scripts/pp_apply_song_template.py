#!/usr/bin/env python3
"""Rewrite a song presentation using lyric slide payloads.

The payload is expected to be JSON with the following shape (example):

{
  "title": "I Thank God",
  "arrangementName": "Sunday",
  "groupName": "Lyrics",
  "sections": [
    {
      "id": "section-1",
      "name": "Verse 1",
      "sequenceLabel": "Verse 1",
      "slides": [["Line one", "Line two"], ["Next line"]]
    },
    ...
  ]
}

Each entry in ``slides`` is rendered as a single ProPresenter slide. The script
clears the existing cues, cue groups, and arrangements before rebuilding the
presentation.
"""

from __future__ import annotations

import json
import math
import os
import random
import re
import subprocess
import sys
import uuid
import zipfile
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable, Optional, Tuple

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))

sys.path.insert(0, SCRIPT_DIR)
from pb_runtime_compat import ensure_protobuf_runtime, relax_protobuf_runtime_check  # type: ignore

ensure_protobuf_runtime()
relax_protobuf_runtime_check()

sys.path.insert(0, os.path.join(PROJECT_ROOT, "src", "gen"))

import action_pb2  # type: ignore
import presentation_pb2  # type: ignore
import presentationSlide_pb2  # type: ignore
import slide_pb2  # type: ignore
import basicTypes_pb2  # type: ignore
import cue_pb2  # type: ignore
import graphicsData_pb2  # type: ignore

NON_LYRIC_KEYWORDS = (
    "intro",
    "turnaround",
    "turn around",
    "instrumental",
    "outro",
    "interlude",
    "tag",
    "ending",
)

GROUP_COLOR_PALETTE: tuple[tuple[float, float, float, float], ...] = (
    (0.05, 0.40, 0.75, 1.0),
    (0.36, 0.65, 0.20, 1.0),
    (0.80, 0.32, 0.15, 1.0),
    (0.56, 0.28, 0.67, 1.0),
    (0.92, 0.56, 0.14, 1.0),
    (0.18, 0.55, 0.60, 1.0),
    (0.78, 0.18, 0.50, 1.0),
    (0.30, 0.30, 0.80, 1.0),
)

BACKGROUND_LIGHTS_GROUP_NAME = "Background & Lights"
SERVICE_TIMER_NAME = "Service Timer"
BACKGROUND_MEDIA_DIR = Path.home() / "Documents" / "Word Of Life" / "Backgrounds"
BACKGROUND_MEDIA_EXTENSIONS = {".mov", ".mp4", ".m4v"}


def new_uuid() -> str:
    return str(uuid.uuid4()).upper()


def set_color(color: basicTypes_pb2.Color, red: float, green: float, blue: float, alpha: float = 1.0) -> None:
    color.red = red
    color.green = green
    color.blue = blue
    color.alpha = alpha


def parse_color(value: Any, default: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    if isinstance(value, (list, tuple)) and len(value) == 4:
        try:
            r, g, b, a = (float(value[0]), float(value[1]), float(value[2]), float(value[3]))
            return (r, g, b, a)
        except Exception:
            return default
    if isinstance(value, dict):
        try:
            return (
                float(value.get('red', default[0])),
                float(value.get('green', default[1])),
                float(value.get('blue', default[2])),
                float(value.get('alpha', default[3])),
            )
        except Exception:
            return default
    return default


def sanitize_text(value: str) -> str:
    normalized = value.replace('\u2019', "'")
    return " ".join(normalized.strip().split())


def is_non_lyric_section(name: str) -> bool:
    lowered = name.strip().lower()
    if not lowered:
        return False
    return any(keyword in lowered for keyword in NON_LYRIC_KEYWORDS)


def normalize_label(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.strip().lower().split())


ROMAN_NUMERAL_MAP = {
    "i": 1,
    "ii": 2,
    "iii": 3,
    "iv": 4,
    "v": 5,
    "vi": 6,
    "vii": 7,
    "viii": 8,
    "ix": 9,
    "x": 10,
    "xi": 11,
    "xii": 12,
    "xiii": 13,
    "xiv": 14,
    "xv": 15,
    "xvi": 16,
    "xvii": 17,
    "xviii": 18,
    "xix": 19,
    "xx": 20,
}

LABEL_NUMBER_SUFFIX_RE = re.compile(r"^(?P<label>.+?)\s*(?P<number>\d+[a-z]?|[ivxlcdm]+)$", re.IGNORECASE)


def normalize_sequence_number(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, bool):  # bool is subclass of int, guard it out
        return None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return str(int(value))
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if text.isdigit():
            return text
        lowered = text.lower()
        if lowered in ROMAN_NUMERAL_MAP:
            return str(ROMAN_NUMERAL_MAP[lowered])
        if re.fullmatch(r"\d+[a-z]", text, flags=re.IGNORECASE):
            return text.lower()
        return text
    return None


def extract_label_components(value: Any) -> tuple[str, Optional[str]]:
    normalized = normalize_label(value)
    if not normalized:
        return "", None
    parts = normalized.split()
    if len(parts) >= 2:
        last = parts[-1]
        number = normalize_sequence_number(last)
        if number is not None:
            base = " ".join(parts[:-1]).strip()
            if base:
                return base, number
    match = LABEL_NUMBER_SUFFIX_RE.match(normalized)
    if match:
        base = normalize_label(match.group("label"))
        number = normalize_sequence_number(match.group("number"))
        if base:
            return base, number
    return normalized, None


def describe_section(section: Optional[dict[str, Any]]) -> str:
    if not isinstance(section, dict):
        return "(no match)"
    for key in ("sequenceLabel", "name", "label"):
        value = section.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    identifier = section.get("id")
    return str(identifier).strip() if identifier else "(unnamed)"


def parse_timer_seconds(value: Any) -> Optional[float]:
    if isinstance(value, (int, float)):
        try:
            result = float(value)
        except (TypeError, ValueError):
            return None
        if math.isfinite(result) and result > 0:
            return result
        return None
    if isinstance(value, str):
        try:
            parsed = float(value.strip())
        except (TypeError, ValueError):
            return None
        if math.isfinite(parsed) and parsed > 0:
            return parsed
    return None


def parse_timer_descriptor(value: Any) -> Optional[dict[str, Any]]:
    if not isinstance(value, dict):
        return None
    name = value.get('name')
    uuid_value = value.get('uuid')
    allows = value.get('allowsOverrun')
    parsed: dict[str, Any] = {}
    if isinstance(name, str) and name.strip():
        parsed['name'] = name.strip()
    if isinstance(uuid_value, str) and uuid_value.strip():
        parsed['uuid'] = uuid_value.strip()
    if isinstance(allows, bool):
        parsed['allowsOverrun'] = allows
    return parsed if parsed else None


def add_audience_look_action(cue: cue_pb2.Cue, look_name: str) -> None:
    look_name = look_name.strip()
    if not look_name:
        return

    action = cue.actions.add()
    action.uuid.string = new_uuid()
    action.name = f"Audience Look • {look_name}"
    action.type = action_pb2.Action.ActionType.ACTION_TYPE_AUDIENCE_LOOK
    action.isEnabled = True
    action.delay_time = 0.0
    action.label.text = ''
    set_color(action.label.color, 0.054, 0.211, 0.588, 1.0)
    action.audience_look.identification.parameter_name = look_name


def add_stage_layout_action(cue: cue_pb2.Cue, layout_info: Optional[dict[str, Any]]) -> None:
    if not layout_info:
        return

    layout_name = str(layout_info.get('layoutName') or '').strip()
    layout_uuid = str(layout_info.get('layoutUuid') or '').strip()
    assignments_data = layout_info.get('assignments')
    if not isinstance(assignments_data, list) or not assignments_data:
        return

    action = cue.actions.add()
    action.uuid.string = new_uuid()
    action.name = layout_name or 'Stage Layout'
    action.type = action_pb2.Action.ActionType.ACTION_TYPE_STAGE_LAYOUT
    action.isEnabled = True
    action.delay_time = 0.0
    action.label.text = ''
    set_color(action.label.color, 0.054, 0.211, 0.588, 1.0)

    for entry in assignments_data:
        if not isinstance(entry, dict):
            continue
        screen_uuid = str(entry.get('uuid') or entry.get('screenUuid') or '').strip()
        screen_name = str(entry.get('name') or entry.get('screenName') or '').strip()
        assignment = action.stage.stage_screen_assignments.add()
        if screen_uuid:
            assignment.screen.parameter_uuid.string = screen_uuid
        if screen_name:
            assignment.screen.parameter_name = screen_name
        if layout_uuid:
            assignment.layout.parameter_uuid.string = layout_uuid
        if layout_name:
            assignment.layout.parameter_name = layout_name


def add_background_lights_group(
    doc: presentation_pb2.Presentation,
    arrangement_group_ids: list[str],
    font_face: str,
    font_family: str,
    font_size: int,
    font_bold: bool,
    all_caps: bool,
    text_color: tuple[float, float, float, float],
    fill_color: tuple[float, float, float, float],
    timer_seconds: Optional[float],
    audience_look_name: str,
    stage_layout_info: Optional[dict[str, Any]],
    timer_descriptor: Optional[dict[str, Any]],
    background_spec: Optional[dict[str, Any]] = None,
) -> bool:
    group = doc.cue_groups.add()
    group_uuid = new_uuid()
    arrangement_group_ids.append(group_uuid)
    group.group.uuid.string = group_uuid
    group.group.name = BACKGROUND_LIGHTS_GROUP_NAME
    palette_color = GROUP_COLOR_PALETTE[0]
    set_color(group.group.color, *palette_color)
    group.group.application_group_identifier.string = new_uuid()
    group.group.application_group_name = BACKGROUND_LIGHTS_GROUP_NAME
    group.group.hotKey.Clear()

    cue = doc.cues.add()
    cue_uuid = new_uuid()
    cue.uuid.string = cue_uuid
    cue.isEnabled = True
    cue.completion_action_type = cue_pb2.Cue.CompletionActionType.Value('COMPLETION_ACTION_TYPE_LAST')
    cue.hot_key.Clear()

    slide_action = cue.actions.add()
    slide_action.uuid.string = new_uuid()
    slide_action.type = action_pb2.Action.ActionType.ACTION_TYPE_PRESENTATION_SLIDE
    slide_action.isEnabled = True
    slide_action.delay_time = 0.0
    slide_action.name = BACKGROUND_LIGHTS_GROUP_NAME
    slide_action.label.Clear()
    slide_action.layer_identification.uuid.string = "slides"
    slide_action.layer_identification.name = "Slides"

    presentation_slide = build_lyric_slide(
        [],
        font=font_face,
        font_family=font_family,
        font_size=font_size,
        font_bold=font_bold,
        all_caps=all_caps,
        text_color=text_color,
        fill_color=fill_color,
    )
    slide_action.slide.presentation.CopyFrom(presentation_slide)

    group.cue_identifiers.add().string = cue_uuid

    clear_action = cue.actions.add()
    clear_action.uuid.string = new_uuid()
    clear_action.name = 'Clear Slide'
    clear_action.type = action_pb2.Action.ActionType.ACTION_TYPE_CLEAR
    clear_action.isEnabled = True
    clear_action.delay_time = 0.0
    clear_action.label.text = ''
    set_color(clear_action.label.color, 0.054, 0.211, 0.588, 1.0)
    clear_action.clear.target_layer = action_pb2.Action.ClearType.ClearTargetLayer.CLEAR_TARGET_LAYER_SLIDE

    if timer_seconds is not None and math.isfinite(timer_seconds) and timer_seconds > 0:
        timer_action = cue.actions.add()
        timer_action.uuid.string = new_uuid()
        descriptor_name = str(timer_descriptor.get('name')) if timer_descriptor else ''
        timer_name = descriptor_name.strip() or SERVICE_TIMER_NAME
        timer_action.name = timer_name
        timer_action.type = action_pb2.Action.ActionType.ACTION_TYPE_TIMER
        timer_action.isEnabled = True
        timer_action.delay_time = 0.0
        timer_action.label.text = ''
        set_color(timer_action.label.color, 0.054, 0.211, 0.588, 1.0)
        timer_action.timer.action_type = action_pb2.Action.TimerType.TimerAction.ACTION_RESET_AND_START
        timer_action.timer.timer_identification.parameter_name = timer_name
        timer_uuid = ''
        if timer_descriptor and isinstance(timer_descriptor.get('uuid'), str):
            timer_uuid = timer_descriptor['uuid'].strip()
        if timer_uuid:
            timer_action.timer.timer_identification.parameter_uuid.string = timer_uuid
        else:
            timer_action.timer.timer_identification.parameter_uuid.string = new_uuid()
        timer_cfg = timer_action.timer.timer_configuration
        timer_cfg.Clear()
        allows_override = timer_descriptor.get('allowsOverrun') if isinstance(timer_descriptor, dict) else None
        timer_cfg.allows_overrun = bool(allows_override) if isinstance(allows_override, bool) else False
        timer_cfg.countdown.duration = float(timer_seconds)
        timer_cfg.countdown.SetInParent()

    if audience_look_name.strip():
        add_audience_look_action(cue, audience_look_name)

    add_stage_layout_action(cue, stage_layout_info)

    attach_background_media(cue, background_spec)

    return True


def rtf_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def build_rtf(lines: Iterable[str], font: str, font_size: int, *, bold: bool, all_caps: bool = False) -> bytes:
    raw_lines = [str(line) for line in lines if str(line).strip()]
    if not raw_lines:
        raw_lines = [" "]

    half_points = max(2, int(round(font_size * 2)))
    font_escaped = rtf_escape(font)

    prefix = r"\pard\tx0\pardeftab1300\sl192\slmult1\pardirnatural\qc\partightenfactor0"
    style = "\\f0"
    if bold:
        style += "\\b"
    style += f"\\fs{half_points} \\cf2 \\CocoaLigature0 "

    first_line = rtf_escape(raw_lines[0].upper() if all_caps else raw_lines[0])
    body = prefix + "\n" + style + first_line
    if len(raw_lines) > 1:
        body += "\\"
        for extra in raw_lines[1:]:
            body += "\n" + rtf_escape(extra.upper() if all_caps else extra)

    rtf = (
        r"{\rtf1\ansi\ansicpg1252\cocoartf2822\cocoatextscaling0\cocoaplatform0"
        r"{\fonttbl\f0\fnil\fcharset0 " + font_escaped + ";}"
        r"{\colortbl;\red255\green255\blue255;\red255\green255\blue255;\red0\green0\blue0;}"
        r"{\*\expandedcolortbl;;\cssrgb\c100000\c100000\c100000;\csgray\c0;}"
        r"\deftab1300\n"
        + body
        + "}"
    )
    return rtf.encode("utf-8")


def _rectangle_path(path: slide_pb2.Slide.Element.Path) -> None:
    path.closed = True
    coordinates = ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))
    for x, y in coordinates:
        point = path.points.add()
        point.point.x = x
        point.point.y = y
        point.q0.x = x
        point.q0.y = y
        point.q1.x = x
        point.q1.y = y
    path.shape.type = path.shape.TYPE_RECTANGLE


def build_lyric_slide(
    lines: Iterable[str],
    *,
    font: str,
    font_family: str,
    font_size: int,
    font_bold: bool,
    all_caps: bool,
    text_color: tuple[float, float, float, float],
    fill_color: tuple[float, float, float, float],
) -> presentationSlide_pb2.PresentationSlide:
    presentation_slide = presentationSlide_pb2.PresentationSlide()

    slide = slide_pb2.Slide()
    slide.uuid.string = new_uuid()
    slide.draws_background_color = False
    set_color(slide.background_color, 0.0, 0.0, 0.0, 0.0)
    slide.size.width = 1920.0
    slide.size.height = 1080.0

    slide_element = slide.elements.add()
    element = slide_element.element
    element.uuid.string = new_uuid()
    element.name = "Lyrics"
    element.name = "Lyrics"
    element.bounds.origin.x = 150.0
    element.bounds.origin.y = 405.4
    element.bounds.size.width = 1620.0
    element.bounds.size.height = 269.2
    element.opacity = 1.0
    set_color(element.fill.color, *fill_color)
    element.stroke.width = 3.0
    set_color(element.stroke.color, 1.0, 1.0, 1.0, 1.0)
    element.shadow.angle = 315.0
    element.shadow.offset = 5.0
    element.shadow.radius = 5.0
    element.shadow.opacity = 0.75
    element.shadow.color.alpha = 1.0
    element.feather.radius = 0.05
    _rectangle_path(element.path)

    text = element.text
    attrs = text.attributes
    attrs.font.name = font
    attrs.font.face = font
    attrs.font.family = font_family
    attrs.font.size = float(font_size)
    attrs.font.bold = font_bold
    set_color(attrs.text_solid_fill, *text_color)
    attrs.paragraph_style.alignment = attrs.paragraph_style.ALIGNMENT_CENTER
    attrs.paragraph_style.line_height_multiple = 0.8
    attrs.paragraph_style.default_tab_interval = 65.0
    attrs.capitalization = 1 if all_caps else 0

    sanitized_lines = [sanitize_text(line) for line in lines]
    sanitized_lines = [line for line in sanitized_lines if line]
    if not sanitized_lines:
        sanitized_lines = [" "]
    text.rtf_data = build_rtf(sanitized_lines, font, font_size, bold=font_bold, all_caps=all_caps)
    text.vertical_alignment = text.VERTICAL_ALIGNMENT_MIDDLE
    text.scale_behavior = text.SCALE_BEHAVIOR_ADJUST_CONTAINER_HEIGHT
    text.is_superscript_standardized = True
    text.transformDelimiter = "  \u2022  "
    text_shadow = text.shadow
    text_shadow.angle = 315.0
    text_shadow.offset = 5.0
    text_shadow.radius = 5.0
    text_shadow.opacity = 0.75
    text_shadow.color.alpha = 1.0

    chord_color = text.chord_pro.color
    chord_color.red = 0.993
    chord_color.green = 0.76
    chord_color.blue = 0.032
    chord_color.alpha = 1.0

    slide.element_build_order.add().string = element.uuid.string
    slide_element.info = 3
    slide_element.text_scroller.should_repeat = True
    slide_element.text_scroller.scroll_rate = 0.5
    slide_element.text_scroller.repeat_distance = 0.06172839506172839

    presentation_slide.base_slide.CopyFrom(slide)
    presentation_slide.chord_chart.platform = basicTypes_pb2.URL.Platform.Value('PLATFORM_MACOS')
    presentation_slide.notes.Clear()
    presentation_slide.template_guidelines.clear()
    return presentation_slide


def locate_protobuf_payload(path: str) -> Tuple[str, str]:
    abs_path = os.path.abspath(path)
    if os.path.isdir(abs_path):
        candidates: list[str] = []
        for root, _, files in os.walk(abs_path):
            for name in files:
                if name.lower().endswith(".pro"):
                    candidates.append(os.path.join(root, name))
        if not candidates:
            raise FileNotFoundError(f"No presentation payload found inside {abs_path}")
        candidates.sort(key=len)
        return abs_path, candidates[0]
    return os.path.dirname(abs_path), abs_path


def read_presentation(path: str) -> Tuple[presentation_pb2.Presentation, Optional[str], Optional[list[zipfile.ZipInfo]], Optional[dict[str, bytes]]]:
    with open(path, "rb") as handle:
        header = handle.read(4)

    doc = presentation_pb2.Presentation()
    if header == b"PK\x03\x04":
        with zipfile.ZipFile(path, "r") as zf:
            data_map: dict[str, bytes] = {}
            target_name: Optional[str] = None
            for info in zf.infolist():
                data = zf.read(info.filename)
                data_map[info.filename] = data
                if info.filename.lower().endswith(".pro"):
                    try:
                        doc.ParseFromString(data)
                        target_name = info.filename
                        break
                    except Exception:
                        continue
            if target_name is None:
                raise ValueError(f"No presentation payload found inside zip {path}")
            return doc, target_name, zf.infolist(), data_map
    else:
        with open(path, "rb") as fh:
            doc.ParseFromString(fh.read())
        return doc, None, None, None

    raise ValueError("Unhandled presentation format")


def write_presentation(path: str, doc: presentation_pb2.Presentation, zip_member: Optional[str], infos: Optional[list[zipfile.ZipInfo]], data_map: Optional[dict[str, bytes]]) -> None:
    if zip_member and infos is not None and data_map is not None:
        data_map[zip_member] = doc.SerializeToString()
        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp_path = tmp.name
        try:
            with zipfile.ZipFile(tmp_path, "w") as new_zip:
                for info in infos:
                    data = data_map.get(info.filename)
                    if data is None:
                        continue
                    new_info = zipfile.ZipInfo(filename=info.filename, date_time=info.date_time)
                    new_info.compress_type = info.compress_type
                    new_info.external_attr = info.external_attr
                    new_info.internal_attr = info.internal_attr
                    new_info.flag_bits = info.flag_bits
                    new_info.create_system = info.create_system
                    new_info.create_version = info.create_version
                    new_info.extract_version = info.extract_version
                    new_info.volume = info.volume
                    new_zip.writestr(new_info, data)
            os.replace(tmp_path, path)
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
    else:
        with open(path, "wb") as fh:
            fh.write(doc.SerializeToString())


def _choose_background_file(preferred_name: Optional[str] = None) -> Optional[Path]:
    directory = BACKGROUND_MEDIA_DIR
    if not directory.exists() or not directory.is_dir():
        return None

    candidates = [entry for entry in directory.iterdir() if entry.is_file() and entry.suffix.lower() in BACKGROUND_MEDIA_EXTENSIONS]
    if not candidates:
        return None

    if preferred_name:
        for candidate in candidates:
            if candidate.name.lower() == preferred_name.lower():
                return candidate

    return random.choice(candidates)


def _infer_media_dimensions(path: str) -> Tuple[float, float]:
    width: Optional[float] = None
    height: Optional[float] = None
    try:
        result = subprocess.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', path], capture_output=True, text=True, check=False)
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                line = line.strip()
                if line.lower().startswith('pixelwidth:'):
                    try:
                        width = float(line.split(':', 1)[1].strip())
                    except ValueError:
                        width = None
                if line.lower().startswith('pixelheight:'):
                    try:
                        height = float(line.split(':', 1)[1].strip())
                    except ValueError:
                        height = None
    except Exception:
        width = height = None
    if not width or not height or width <= 0 or height <= 0:
        return 1920.0, 1080.0
    return width, height


def attach_background_media(cue: cue_pb2.Cue, config: Optional[dict[str, Any]]) -> None:
    if not cue:
        return

    preferred_name: Optional[str] = None
    explicit_path: Optional[str] = None
    duration_value: Optional[float] = None
    explicit_volume: Optional[float] = None
    playback_behavior: Optional[str] = None
    fade_in: Optional[bool] = None
    fade_out: Optional[bool] = None
    times_to_loop: Optional[int] = None
    frame_rate: Optional[float] = None
    soft_loop_duration: Optional[float] = None

    if isinstance(config, dict):
        for key in ('filePath', 'path', 'absolutePath'):
            value = config.get(key)
            if isinstance(value, str) and value.strip():
                explicit_path = value.strip()
                break
        pref = config.get('preferredFile') or config.get('preferredName')
        if isinstance(pref, str) and pref.strip():
            preferred_name = pref.strip()
        if isinstance(config.get('durationSeconds'), (int, float)):
            duration_value = float(config['durationSeconds'])
        elif isinstance(config.get('duration'), (int, float)):
            duration_value = float(config['duration'])
        if isinstance(config.get('volume'), (int, float)):
            explicit_volume = float(config['volume'])
        play_raw = config.get('playbackBehavior')
        if isinstance(play_raw, str) and play_raw.strip():
            playback_behavior = play_raw.strip().upper()
        if isinstance(config.get('fadeIn'), bool):
            fade_in = config['fadeIn']
        if isinstance(config.get('fadeOut'), bool):
            fade_out = config['fadeOut']
        if isinstance(config.get('timesToLoop'), int):
            times_to_loop = config['timesToLoop']
        fr_value = config.get('frameRate') or config.get('frame_rate')
        if isinstance(fr_value, (int, float)):
            frame_rate = float(fr_value)
        sl_value = config.get('softLoopDuration') or config.get('soft_loop_duration')
        if isinstance(sl_value, (int, float)):
            soft_loop_duration = float(sl_value)

    chosen_path: Optional[Path] = None
    if explicit_path:
        candidate = Path(os.path.expanduser(explicit_path))
        if candidate.exists():
            chosen_path = candidate
        else:
            print(f"song_background_warning:missing_file:{candidate}", flush=True)

    if chosen_path is None:
        chosen_path = _choose_background_file(preferred_name)
        if chosen_path is None:
            print('song_background_warning:no_candidates', flush=True)
            return

    try:
        absolute_path = chosen_path.resolve()
    except Exception:
        absolute_path = chosen_path.absolute()

    documents_root = Path.home() / 'Documents'
    documents_rel: Optional[str]
    try:
        documents_rel = absolute_path.relative_to(documents_root).as_posix()
        local_root = basicTypes_pb2.URL.LocalRelativePath.Root.Value('ROOT_USER_DOCUMENTS')
    except ValueError:
        documents_rel = absolute_path.name
        local_root = basicTypes_pb2.URL.LocalRelativePath.Root.Value('ROOT_USER_HOME')

    action = cue.actions.add()
    action.uuid.string = new_uuid()
    action.name = absolute_path.stem
    action.type = action_pb2.Action.ActionType.ACTION_TYPE_MEDIA
    action.isEnabled = True
    action.delay_time = 0.0
    action.label.text = ''
    set_color(action.label.color, 0.054, 0.211, 0.588, 1.0)

    if duration_value and math.isfinite(duration_value) and duration_value > 0:
        action.duration = float(duration_value)

    media = action.media
    media.layer_type = action_pb2.Action.MediaType.LayerType.LAYER_TYPE_BACKGROUND

    element = media.element
    element.uuid.string = new_uuid()

    format_hint = absolute_path.suffix.lstrip('.')
    if format_hint:
        element.metadata.format = format_hint.upper()

    absolute_uri = absolute_path.as_uri()
    element.url.absolute_string = absolute_uri
    element.url.platform = basicTypes_pb2.URL.Platform.PLATFORM_MACOS
    element.url.local.root = local_root
    element.url.local.path = documents_rel.replace('\\', '/') if documents_rel else absolute_path.name

    width, height = _infer_media_dimensions(str(absolute_path))

    video_props = element.video
    drawing = video_props.drawing
    drawing.scale_behavior = graphicsData_pb2.Media.DrawingProperties.ScaleBehavior.SCALE_BEHAVIOR_FILL
    drawing.scale_alignment = graphicsData_pb2.Media.DrawingProperties.ScaleAlignment.SCALE_ALIGNMENT_MIDDLE_CENTER
    drawing.natural_size.width = float(width)
    drawing.natural_size.height = float(height)
    drawing.custom_image_bounds.origin.x = 0.0
    drawing.custom_image_bounds.origin.y = 0.0
    drawing.custom_image_bounds.size.width = float(width)
    drawing.custom_image_bounds.size.height = float(height)
    drawing.crop_enable = False
    drawing.crop_insets.top = 0.0
    drawing.crop_insets.bottom = 0.0
    drawing.crop_insets.left = 0.0
    drawing.crop_insets.right = 0.0

    transport = video_props.transport
    transport.play_rate = 1.0
    transport.should_fade_in = True if fade_in is None else bool(fade_in)
    transport.should_fade_out = True if fade_out is None else bool(fade_out)
    transport.times_to_loop = int(times_to_loop) if isinstance(times_to_loop, int) and times_to_loop > 0 else 1

    if playback_behavior:
        key = f'PLAYBACK_BEHAVIOR_{playback_behavior.upper()}'
        try:
            transport.playback_behavior = graphicsData_pb2.Media.TransportProperties.PlaybackBehavior.Value(key)
        except ValueError:
            transport.playback_behavior = graphicsData_pb2.Media.TransportProperties.PlaybackBehavior.PLAYBACK_BEHAVIOR_LOOP
    else:
        transport.playback_behavior = graphicsData_pb2.Media.TransportProperties.PlaybackBehavior.PLAYBACK_BEHAVIOR_LOOP

    if duration_value and math.isfinite(duration_value) and duration_value > 0:
        transport.end_point = float(duration_value)
        transport.out_point = float(duration_value)

    if frame_rate and math.isfinite(frame_rate) and frame_rate > 0:
        video_props.video.frame_rate = float(frame_rate)
    else:
        video_props.video.frame_rate = 30.0

    if soft_loop_duration and math.isfinite(soft_loop_duration) and soft_loop_duration >= 0:
        video_props.video.soft_loop_duration = float(soft_loop_duration)
    else:
        video_props.video.soft_loop_duration = 0.5

    volume = explicit_volume if explicit_volume is not None else 1.0
    try:
        video_props.audio.volume = float(volume)
    except Exception:
        video_props.audio.volume = 1.0

    media.audio.SetInParent()

    try:
        payload = {
            'file': absolute_path.name,
            'path': element.url.local.path,
            'behavior': graphicsData_pb2.Media.TransportProperties.PlaybackBehavior.Name(transport.playback_behavior),
        }
        print(f"song_background_media:{json.dumps(payload)}", flush=True)
    except Exception:
        print(f"song_background_media:{absolute_path.name}", flush=True)

def rebuild_song(doc: presentation_pb2.Presentation, payload: dict[str, Any]) -> None:
    title = str(payload.get("title") or "").strip()
    arrangement_name = str(payload.get("arrangementName") or "Default").strip() or "Default"
    sections = payload.get("sections") or []
    timer_seconds = parse_timer_seconds(payload.get("timerSeconds"))
    audience_look_name = str(payload.get("audienceLookName") or "").strip()
    stage_layout_raw = payload.get("stageLayout")
    stage_layout_info = stage_layout_raw if isinstance(stage_layout_raw, dict) else None
    timer_descriptor = parse_timer_descriptor(payload.get("timerDescriptor"))

    doc.application_info.platform = basicTypes_pb2.ApplicationInfo.Platform.Value('PLATFORM_MACOS')
    doc.application_info.platform_version.major_version = 15
    doc.application_info.platform_version.minor_version = 6
    doc.application_info.platform_version.patch_version = 1
    doc.application_info.application = basicTypes_pb2.ApplicationInfo.Application.Value('APPLICATION_PROPRESENTER')
    doc.application_info.application_version.major_version = 19
    doc.application_info.application_version.patch_version = 1
    doc.application_info.application_version.build = "318767361"

    doc.name = title or doc.name
    doc.category = payload.get("category") or doc.category or "Song"
    doc.background.color.alpha = 1.0
    doc.chord_chart.platform = basicTypes_pb2.URL.Platform.Value('PLATFORM_MACOS')
    doc.ccli.SetInParent()
    doc.timeline.duration = int(payload.get("timelineDuration") or 300)

    doc.cues.clear()
    doc.cue_groups.clear()
    doc.arrangements.clear()

    font_face = str(payload.get("fontFace") or "BebasNeueBold").strip() or "BebasNeueBold"
    font_family = str(payload.get("fontFamily") or "Bebas Neue").strip() or "Bebas Neue"
    font_size = int(payload.get("fontSize") or 120)
    font_bold = bool(payload.get("fontBold", True))
    all_caps = bool(payload.get("allCaps", True))
    text_color = parse_color(payload.get("textColor"), (1.0, 1.0, 1.0, 1.0))
    fill_color = parse_color(payload.get("fillColor"), (0.13, 0.59, 0.95, 1.0))

    background_spec: Optional[dict[str, Any]] = None
    raw_background = payload.get("backgroundMedia")
    if isinstance(raw_background, dict):
        background_spec = raw_background
    else:
        alt_background = payload.get("background")
        if isinstance(alt_background, dict):
            background_spec = alt_background

    arrangement_group_ids: list[str] = []
    background_added = add_background_lights_group(
        doc,
        arrangement_group_ids,
        font_face,
        font_family,
        font_size,
        font_bold,
        all_caps,
        text_color,
        fill_color,
        timer_seconds,
        audience_look_name,
        stage_layout_info,
        timer_descriptor,
        background_spec,
    )

    sections_list = [section for section in sections if isinstance(section, dict)]
    section_records: list[dict[str, Any]] = []
    sections_by_id: defaultdict[str, list[int]] = defaultdict(list)
    labels_to_indices: defaultdict[str, list[int]] = defaultdict(list)
    base_number_to_indices: defaultdict[tuple[str, Optional[str]], list[int]] = defaultdict(list)
    base_number_usage: defaultdict[str, set[str]] = defaultdict(set)

    for idx, section in enumerate(sections_list):
        section_id = str(section.get("id") or "").strip()
        normalized_labels: set[str] = set()
        base_pairs: set[tuple[str, Optional[str]]] = set()

        primary_label = None
        for key_name in ("sequenceLabel", "name"):
            raw_label = section.get(key_name)
            norm = normalize_label(raw_label)
            if norm:
                normalized_labels.add(norm)
            base, number = extract_label_components(raw_label)
            if base:
                base_pairs.add((base, number))
                base_pairs.add((base, None))
                if number is not None:
                    base_number_usage[base].add(number)
            if primary_label is None and isinstance(raw_label, str) and raw_label.strip():
                primary_label = raw_label.strip()

        if primary_label is None:
            if isinstance(section.get("name"), str) and section["name"].strip():
                primary_label = str(section["name"]).strip()
            elif isinstance(section.get("sequenceLabel"), str) and section["sequenceLabel"].strip():
                primary_label = str(section["sequenceLabel"]).strip()

        record = {
            "section": section,
            "id": section_id or None,
            "primary_label": primary_label,
        }
        section_records.append(record)

        if section_id:
            sections_by_id[section_id].append(idx)
        for norm in normalized_labels:
            labels_to_indices[norm].append(idx)
        for base_pair in base_pairs:
            base_number_to_indices[base_pair].append(idx)

        # Preserve normalized labels for later matching fallback
        record["normalized_labels"] = normalized_labels
        record["base_pairs"] = base_pairs

        base_label, number_label = extract_label_components(primary_label)
        record["base_label"] = base_label if base_label else None
        record["number_label"] = number_label
        if base_label and number_label:
            base_number_usage[base_label].add(number_label)

    sequence_entries = payload.get("sequence")
    ordered_units: list[tuple[Optional[dict[str, Any]], Optional[str], Optional[int]]] = []
    used_indices: set[int] = set()
    match_logs: list[str] = []

    multi_number_bases: set[str] = set()
    for base, numbers in base_number_usage.items():
        if len(numbers) > 1:
            multi_number_bases.add(base)

    def select_candidate(indices: Iterable[int], reason: str, *, allow_reuse: bool = False) -> tuple[Optional[int], str]:
        candidates = list(indices)
        if not candidates:
            return None, reason
        available = candidates if allow_reuse else [idx for idx in candidates if idx not in used_indices]
        if not available:
            return None, reason
        chosen = available[0]
        reused = chosen in used_indices
        if not reused:
            used_indices.add(chosen)
        result_reason = reason
        if reused:
            result_reason = f"{reason} (reuse)"
        if len(available) > 1:
            result_reason = f"{result_reason} (ambiguous:{len(available)})"
        return chosen, result_reason

    if isinstance(sequence_entries, list) and sequence_entries:
        for seq_index, raw_entry in enumerate(sequence_entries):
            if not isinstance(raw_entry, dict):
                continue

            section_match_index: Optional[int] = None
            match_reason = "unmatched"

            def try_select(indices: Iterable[int], reason: str, *, allow_reuse: bool = False) -> bool:
                nonlocal section_match_index, match_reason
                if section_match_index is not None:
                    return True
                candidate_idx, candidate_reason = select_candidate(indices, reason, allow_reuse=allow_reuse)
                if candidate_idx is not None:
                    section_match_index = candidate_idx
                    match_reason = candidate_reason
                    return True
                return False

            label_raw = raw_entry.get("label")
            label_text = str(label_raw).strip() if isinstance(label_raw, str) else ""
            normalized_label = normalize_label(label_text)
            base_from_label, number_from_label = extract_label_components(label_text)

            entry_number = normalize_sequence_number(raw_entry.get("number")) or number_from_label
            base_key = base_from_label or normalized_label

            section_id_value = raw_entry.get("sectionId")
            section_id = str(section_id_value).strip() if isinstance(section_id_value, str) else ""
            if section_id:
                try_select(sections_by_id.get(section_id, []), "section-id")

            if entry_number and base_key:
                combined_norm = f"{base_key} {entry_number}".strip()
                if combined_norm:
                    try_select(labels_to_indices.get(combined_norm, []), "label+number")
                    if section_match_index is None:
                        try_select(labels_to_indices.get(combined_norm, []), "label+number", allow_reuse=True)

            if entry_number and base_key:
                try_select(base_number_to_indices.get((base_key, entry_number), []), "base+number")
                if section_match_index is None:
                    try_select(base_number_to_indices.get((base_key, entry_number), []), "base+number", allow_reuse=True)

            if normalized_label:
                try_select(labels_to_indices.get(normalized_label, []), "label")
                if section_match_index is None:
                    try_select(labels_to_indices.get(normalized_label, []), "label", allow_reuse=True)

            if base_key:
                try_select(base_number_to_indices.get((base_key, None), []), "base")
                if section_match_index is None:
                    try_select(base_number_to_indices.get((base_key, None), []), "base", allow_reuse=True)

            matched_section: Optional[dict[str, Any]] = None
            if section_match_index is not None:
                matched_section = section_records[section_match_index]["section"]

            sequence_label_value: Optional[str] = None
            if label_text:
                sequence_label_value = label_text
                if entry_number:
                    append_number = False
                    if base_key:
                        if base_key in multi_number_bases:
                            append_number = True
                        else:
                            numbers = base_number_usage.get(base_key)
                            append_number = bool(numbers and len(numbers) > 1)
                    else:
                        append_number = True
                    if append_number:
                        target_norm = f"{(base_key or '').strip()} {entry_number}".strip()
                        if target_norm and normalize_label(label_text) != target_norm:
                            sequence_label_value = f"{label_text} {entry_number}".strip()
            elif entry_number and matched_section:
                candidate_label = matched_section.get("sequenceLabel") or matched_section.get("name")
                if isinstance(candidate_label, str) and candidate_label.strip():
                    sequence_label_value = candidate_label.strip()
                elif base_key:
                    sequence_label_value = " ".join(part.capitalize() for part in f"{base_key} {entry_number}".split())

            if not sequence_label_value and matched_section:
                candidate_label = matched_section.get("sequenceLabel") or matched_section.get("name")
                if isinstance(candidate_label, str) and candidate_label.strip():
                    sequence_label_value = candidate_label.strip()

            ordered_units.append((matched_section, sequence_label_value, section_match_index))

            section_desc = describe_section(matched_section)
            match_logs.append(
                f"seq#{seq_index + 1:02d} • label='{label_text or '(none)'}' number='{entry_number or '-'}' -> {section_desc} [{match_reason}]"
            )

        for idx, record in enumerate(section_records):
            if idx in used_indices:
                continue
            ordered_units.append((record["section"], None, idx))
            section_desc = describe_section(record["section"])
            match_logs.append(f"leftover section • {section_desc}")
    else:
        for idx, record in enumerate(section_records):
            ordered_units.append((record["section"], None, idx))

    group_cache: dict[int, dict[str, Any]] = {}
    created_group_count = 1 if background_added else 0

    for index, (section, sequence_label, section_record_idx) in enumerate(ordered_units):
        section_name_source = sequence_label or str(section.get("sequenceLabel") if section else "") or str(section.get("name") if section else "")
        section_name = section_name_source.strip() if section_name_source else ""
        if not section_name:
            section_name = f"Section {index + 1}"

        record_for_section = section_records[section_record_idx] if section_record_idx is not None and 0 <= section_record_idx < len(section_records) else None
        if record_for_section is not None:
            base_label = record_for_section.get("base_label")
            number_label = record_for_section.get("number_label")
            primary_label = record_for_section.get("primary_label")
            if base_label and number_label and base_label not in multi_number_bases and number_label.startswith("1"):
                label_source = primary_label or section_name
                trimmed = re.sub(r"\s*\d+$", "", label_source).strip()
                if trimmed:
                    section_name = trimmed

        section_is_non_lyric = is_non_lyric_section(section_name)

        if section_record_idx is not None and section_record_idx in group_cache:
            arrangement_group_ids.append(group_cache[section_record_idx]["group_uuid"])
            continue

        slides: list[list[str]] = []
        if section_is_non_lyric:
            slides = [[]]
        elif section:
            raw_slides = section.get("slides") or section.get("lyricSlides") or []
            if isinstance(raw_slides, list):
                for raw_slide in raw_slides:
                    if not isinstance(raw_slide, list):
                        continue
                    cleaned = [str(line).strip() for line in raw_slide if str(line or "").strip()]
                    if cleaned:
                        slides.append(cleaned)
            if not slides:
                raw_lines = section.get("lyricLines")
                if isinstance(raw_lines, list):
                    cleaned_lines = [str(line).strip() for line in raw_lines if str(line or "").strip()]
                    if cleaned_lines:
                        slides.append(cleaned_lines)

        if not slides:
            if section_is_non_lyric:
                slides = [[]]
            else:
                continue

        group = doc.cue_groups.add()
        group_uuid = new_uuid()
        arrangement_group_ids.append(group_uuid)
        group.group.uuid.string = group_uuid
        group.group.name = section_name

        color_tuple = GROUP_COLOR_PALETTE[created_group_count % len(GROUP_COLOR_PALETTE)]
        set_color(group.group.color, *color_tuple)
        group.group.application_group_identifier.string = new_uuid()
        group.group.application_group_name = section_name

        group.group.hotKey.Clear()

        created_group_count += 1
        for slide_lines in slides:
            cue = doc.cues.add()
            cue_uuid = new_uuid()
            cue.uuid.string = cue_uuid
            cue.isEnabled = True
            cue.completion_action_type = cue_pb2.Cue.CompletionActionType.Value('COMPLETION_ACTION_TYPE_LAST')
            cue.hot_key.Clear()

            action = cue.actions.add()
            action.uuid.string = new_uuid()
            action.type = action_pb2.Action.ActionType.ACTION_TYPE_PRESENTATION_SLIDE
            action.isEnabled = True
            action.name = section_name
            action.label.Clear()
            action.layer_identification.uuid.string = "slides"
            action.layer_identification.name = "Slides"

            presentation_slide = build_lyric_slide(
                slide_lines,
                font=font_face,
                font_family=font_family,
                font_size=font_size,
                font_bold=font_bold,
                all_caps=all_caps,
                text_color=text_color,
                fill_color=fill_color,
            )
            action.slide.presentation.CopyFrom(presentation_slide)

            group.cue_identifiers.add().string = cue_uuid

        if section_record_idx is not None:
            group_cache[section_record_idx] = {
                "group_uuid": group_uuid,
            }

    if arrangement_group_ids:
        arrangement = doc.arrangements.add()
        arrangement_uuid = new_uuid()
        arrangement.uuid.string = arrangement_uuid
        arrangement.name = arrangement_name
        for group_uuid in arrangement_group_ids:
            arrangement.group_identifiers.add().string = group_uuid
        doc.selected_arrangement.string = arrangement_uuid

    if match_logs:
        header_title = title or arrangement_name or "Song"
        print(f"SEQUENCE MATCH SUMMARY • {header_title}")
        for line in match_logs:
            print(f"  {line}")


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print("Usage: python3 scripts/pp_apply_song_template.py /path/to/file.pro '{\"sections\": [...]}'", file=sys.stderr)
        return 1

    target_path = os.path.abspath(argv[1])
    try:
        payload = json.loads(argv[2])
    except json.JSONDecodeError as exc:
        print(f"Invalid JSON payload: {exc}", file=sys.stderr)
        return 1

    bundle_root, data_path = locate_protobuf_payload(target_path)
    doc, member, infos, data_map = read_presentation(data_path)

    if not doc.HasField("uuid") or not doc.uuid.string:
        doc.uuid.string = new_uuid()

    rebuild_song(doc, payload)

    write_presentation(data_path, doc, member, infos, data_map)
    print(f"song_template_slides:{len(doc.cues)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
