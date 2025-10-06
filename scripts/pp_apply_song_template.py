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
import os
import sys
import uuid
import zipfile
import tempfile
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


def rebuild_song(doc: presentation_pb2.Presentation, payload: dict[str, Any]) -> None:
    title = str(payload.get("title") or "").strip()
    arrangement_name = str(payload.get("arrangementName") or "Default").strip() or "Default"
    sections = payload.get("sections") or []

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

    arrangement_group_ids: list[str] = []

    for section_index, section in enumerate(sections):
        slides = section.get("slides") or []
        slides = [
            [str(line).strip() for line in slide if str(line or "").strip()]
            for slide in slides
            if isinstance(slide, list)
        ]
        slides = [slide for slide in slides if slide]
        if not slides:
            continue

        section_name = str(section.get("sequenceLabel") or section.get("name") or "").strip()
        if not section_name:
            section_name = f"Section {section_index + 1}"

        group = doc.cue_groups.add()
        group_uuid = new_uuid()
        arrangement_group_ids.append(group_uuid)
        group.group.uuid.string = group_uuid
        group.group.name = section_name
        set_color(group.group.color, 0.0, 0.466666669, 0.8, 1.0)
        group.group.application_group_identifier.string = new_uuid()
        group.group.application_group_name = section_name

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
            action.label.text = section_name
            set_color(action.label.color, 0.11, 0.65, 0.96, 1.0)
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

    if arrangement_group_ids:
        arrangement = doc.arrangements.add()
        arrangement_uuid = new_uuid()
        arrangement.uuid.string = arrangement_uuid
        arrangement.name = arrangement_name
        for group_uuid in arrangement_group_ids:
            arrangement.group_identifiers.add().string = group_uuid
        doc.selected_arrangement.string = arrangement_uuid


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
