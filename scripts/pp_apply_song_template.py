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


def new_uuid() -> str:
    return str(uuid.uuid4()).upper()


def set_color(color: basicTypes_pb2.Color, red: float, green: float, blue: float, alpha: float = 1.0) -> None:
    color.red = red
    color.green = green
    color.blue = blue
    color.alpha = alpha


def sanitize_text(value: str) -> str:
    cleaned = value.translate({ord(ch): " " for ch in "'\"`"})
    cleaned = "".join(ch if ch.isalnum() or ch.isspace() else " " for ch in cleaned)
    return " ".join(cleaned.split()).strip()


def rtf_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def build_rtf(lines: Iterable[str], font: str, font_size: int) -> bytes:
    escaped_lines = [rtf_escape(line) for line in lines if line]
    if not escaped_lines:
        escaped_lines = [" "]
    body = escaped_lines[0]
    for extra in escaped_lines[1:]:
        body += "\\line " + extra
    rtf = (
        r"{\rtf1\ansi\deff0"
        r"{\fonttbl{\f0 %s;}}"
        r"{\colortbl;\red255\green255\blue255;}"
        r"\f0\fs%s %s}"
    ) % (font, font_size, body)
    return rtf.encode("utf-8")


def build_lyric_slide(lines: Iterable[str], *, font: str, font_size: int) -> presentationSlide_pb2.PresentationSlide:
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
    element.bounds.origin.x = 240.0
    element.bounds.origin.y = 360.0
    element.bounds.size.width = 1440.0
    element.bounds.size.height = 360.0
    element.opacity = 1.0
    element.fill.enable = False

    text = element.text
    attrs = text.attributes
    attrs.font.name = font
    attrs.font.face = font
    attrs.font.family = font
    attrs.font.size = float(font_size)
    attrs.font.bold = False
    set_color(attrs.text_solid_fill, 1.0, 1.0, 1.0, 1.0)
    attrs.paragraph_style.alignment = 2  # Center

    margins = text.margins
    margins.left = 48.0
    margins.right = 48.0
    margins.top = 24.0
    margins.bottom = 24.0

    sanitized_lines = [sanitize_text(line) for line in lines]
    sanitized_lines = [line for line in sanitized_lines if line]
    if not sanitized_lines:
        sanitized_lines = [" "]
    text.rtf_data = build_rtf(sanitized_lines, font, font_size)

    slide.element_build_order.add().string = element.uuid.string

    presentation_slide.base_slide.CopyFrom(slide)
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
    group_name = str(payload.get("groupName") or "Lyrics").strip() or "Lyrics"
    arrangement_name = str(payload.get("arrangementName") or "Default").strip() or "Default"
    sections = payload.get("sections") or []

    doc.name = title or doc.name
    doc.category = payload.get("category") or doc.category or "Song"

    doc.cues.clear()
    doc.cue_groups.clear()
    doc.arrangements.clear()

    group = doc.cue_groups.add()
    group_uuid = new_uuid()
    group.group.uuid.string = group_uuid
    group.group.name = group_name
    set_color(group.group.color, 0.054, 0.211, 0.588, 1.0)
    group.group.application_group_identifier.string = new_uuid()
    group.group.application_group_name = group_name

    font_face = payload.get("fontFace") or "Helvetica Neue"
    font_size = int(payload.get("fontSize") or 70)

    cue_records: list[tuple[str, Optional[str], Optional[str], int, int]] = []

    for section_index, section in enumerate(sections):
        slides = section.get("slides") or []
        section_name = str(section.get("sequenceLabel") or section.get("name") or "").strip()
        section_id = section.get("id")
        total_slides = len(slides)
        for slide_index, slide_lines in enumerate(slides):
            slide_lines = slide_lines or []
            cue = doc.cues.add()
            cue_uuid = new_uuid()
            cue.uuid.string = cue_uuid
            cue.isEnabled = True

            cue_label = section_name or f"Slide {len(cue_records) + 1}"
            if total_slides > 1:
                cue.name = f"{cue_label} {slide_index + 1}"
            else:
                cue.name = cue_label or f"Slide {len(cue_records) + 1}"

            action = cue.actions.add()
            action.uuid.string = new_uuid()
            action.name = cue.name
            action.type = action_pb2.Action.ActionType.ACTION_TYPE_PRESENTATION_SLIDE
            action.isEnabled = True
            action.delay_time = 0.0
            action.label.text = cue_label
            set_color(action.label.color, 0.11, 0.65, 0.96, 1.0)
            action.layer_identification.uuid.string = "slides"
            action.layer_identification.name = "Slides"

            presentation_slide = build_lyric_slide(slide_lines, font=font_face, font_size=font_size)
            action.slide.presentation.CopyFrom(presentation_slide)

            cue_records.append((cue_uuid, section_id, section_name, section_index, slide_index))

    for cue_uuid, *_rest in cue_records:
        group.cue_identifiers.add().string = cue_uuid

    arrangement = doc.arrangements.add()
    arrangement_uuid = new_uuid()
    arrangement.uuid.string = arrangement_uuid
    arrangement.name = arrangement_name
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
