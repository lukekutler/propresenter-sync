#!/usr/bin/env python3
import json
import math
import os
import sys
import uuid
import tempfile
import zipfile
from pathlib import Path
from typing import Tuple, Optional, Any
import subprocess

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..'))

sys.path.insert(0, os.path.join(PROJECT_ROOT, 'scripts'))
from pb_runtime_compat import ensure_protobuf_runtime, relax_protobuf_runtime_check  # type: ignore

ensure_protobuf_runtime()
relax_protobuf_runtime_check()

sys.path.insert(0, os.path.join(PROJECT_ROOT, 'src', 'gen'))

import basicTypes_pb2  # type: ignore
import action_pb2  # type: ignore
import presentation_pb2  # type: ignore
import cue_pb2  # type: ignore
import slide_pb2  # type: ignore
import presentationSlide_pb2  # type: ignore
import graphicsData_pb2  # type: ignore

LABEL_DEFAULT = "Background & Lights"
AUDIENCE_LOOK_DEFAULT = "Full Screen Media"
CLEAR_LABEL = "CLEAR"
CLEAR_PROP_NAME = "Logo"


def new_uuid() -> str:
    return str(uuid.uuid4()).upper()


def set_color(color: basicTypes_pb2.Color, red: float, green: float, blue: float, alpha: float = 1.0) -> None:
    color.red = red
    color.green = green
    color.blue = blue
    color.alpha = alpha


def build_transition_slide() -> presentationSlide_pb2.PresentationSlide:
    slide = slide_pb2.Slide()
    slide.uuid.string = new_uuid()
    slide.draws_background_color = False
    set_color(slide.background_color, 0.0, 0.0, 0.0, 0.0)
    slide.size.width = 1920.0
    slide.size.height = 1080.0

    presentation_slide = presentationSlide_pb2.PresentationSlide()
    presentation_slide.base_slide.CopyFrom(slide)
    presentation_slide.notes.Clear()
    presentation_slide.template_guidelines.clear()

    return presentation_slide


def ensure_group(presentation: presentation_pb2.Presentation, cue_uuids: list[str], label: str) -> presentation_pb2.Presentation.CueGroup:
    presentation.cue_groups.clear()
    group = presentation.cue_groups.add()
    group.group.uuid.string = new_uuid()
    group.group.name = label
    set_color(group.group.color, 0.054, 0.211, 0.588, 1.0)
    group.group.hotKey.Clear()
    group.group.application_group_identifier.string = new_uuid()
    group.group.application_group_name = label
    group.cue_identifiers.clear()
    for cue_uuid in cue_uuids:
        if not cue_uuid:
            continue
        group.cue_identifiers.add().string = cue_uuid
    return group


def ensure_arrangement(presentation: presentation_pb2.Presentation, group_uuid: str) -> None:
    if presentation.arrangements:
        for arrangement in presentation.arrangements:
            arrangement.group_identifiers.clear()
            arrangement.group_identifiers.add().string = group_uuid
    else:
        arrangement = presentation.arrangements.add()
        arrangement.uuid.string = new_uuid()
        arrangement.name = "Default"
        arrangement.group_identifiers.add().string = group_uuid


def assign_group_to_slide_actions(cues: list[cue_pb2.Cue], group_uuid: str, group_name: str) -> None:
    for cue in cues:
        for action in cue.actions:
            if action.type == action_pb2.Action.ActionType.ACTION_TYPE_PRESENTATION_SLIDE:
                action.layer_identification.uuid.string = group_uuid
                action.layer_identification.name = group_name


def locate_protobuf_payload(path: str) -> Tuple[str, str]:
    abs_path = os.path.abspath(path)
    if os.path.isdir(abs_path):
        candidates: list[str] = []
        for root, _, files in os.walk(abs_path):
            for name in files:
                if name.lower().endswith('.pro'):
                    candidates.append(os.path.join(root, name))
        if not candidates:
            raise FileNotFoundError(f'No presentation payload found inside {abs_path}')
        candidates.sort(key=len)
        return abs_path, candidates[0]
    return os.path.dirname(abs_path), abs_path


def read_presentation_bytes(file_path: str) -> Tuple[presentation_pb2.Presentation, Optional[str], Optional[list[zipfile.ZipInfo]], Optional[dict[str, bytes]]]:
    with open(file_path, 'rb') as fh:
        header = fh.read(4)
    doc = presentation_pb2.Presentation()
    if header == b'PK\x03\x04':  # zip file
        with zipfile.ZipFile(file_path, 'r') as zf:
            data_map: dict[str, bytes] = {}
            target_name: Optional[str] = None
            for info in zf.infolist():
                data = zf.read(info.filename)
                data_map[info.filename] = data
                if info.filename.lower().endswith('.pro'):
                    test_doc = presentation_pb2.Presentation()
                    try:
                        test_doc.ParseFromString(data)
                        target_name = info.filename
                        doc.CopyFrom(test_doc)
                        break
                    except Exception:
                        continue
            if target_name is None:
                raise ValueError(f'No presentation payload found inside zip {file_path}')
            return doc, target_name, zf.infolist(), data_map
    else:
        with open(file_path, 'rb') as fh:
            doc.ParseFromString(fh.read())
        return doc, None, None, None
    raise ValueError('Unhandled presentation format')


def write_presentation_bytes(file_path: str, doc: presentation_pb2.Presentation, zip_member: Optional[str], infos: Optional[list[zipfile.ZipInfo]], data_map: Optional[dict[str, bytes]]) -> None:
    if zip_member and infos is not None and data_map is not None:
        data_map[zip_member] = doc.SerializeToString()
        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp_path = tmp.name
        try:
            with zipfile.ZipFile(tmp_path, 'w') as new_zip:
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
            os.replace(tmp_path, file_path)
        finally:
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
    else:
        with open(file_path, 'wb') as fh:
            fh.write(doc.SerializeToString())


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


def add_countdown_timer_action(cue: cue_pb2.Cue, seconds: Optional[float], timer_info: Optional[dict[str, Any]] = None) -> None:
    if seconds is None:
        return
    try:
        duration = float(seconds)
    except (TypeError, ValueError):
        return
    if not math.isfinite(duration) or duration <= 0:
        return

    action = cue.actions.add()
    action.uuid.string = new_uuid()
    action.name = f"Countdown {int(round(duration))}s"
    action.type = action_pb2.Action.ActionType.ACTION_TYPE_TIMER
    action.isEnabled = True
    action.delay_time = 0.0
    action.label.text = ''
    set_color(action.label.color, 0.054, 0.211, 0.588, 1.0)
    action.timer.action_type = action_pb2.Action.TimerType.TimerAction.ACTION_RESET_AND_START
    timer_cfg = action.timer.timer_configuration
    timer_cfg.Clear()
    timer_name = ''
    timer_uuid = ''
    allows_overrun: Optional[bool] = None
    if timer_info:
        timer_name = str(timer_info.get('name') or '').strip()
        timer_uuid = str(timer_info.get('uuid') or '').strip()
        allow_raw = timer_info.get('allowsOverrun')
        if isinstance(allow_raw, bool):
            allows_overrun = allow_raw

    action.timer.timer_identification.parameter_name = timer_name or action.name
    if timer_uuid:
        action.timer.timer_identification.parameter_uuid.string = timer_uuid
    else:
        action.timer.timer_identification.parameter_uuid.string = new_uuid()

    timer_cfg.allows_overrun = allows_overrun if allows_overrun is not None else False
    timer_cfg.countdown.duration = duration
    timer_cfg.countdown.SetInParent()


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


def add_media_file_action(cue: cue_pb2.Cue, media_info: Optional[dict[str, Any]]) -> bool:
    if not media_info or not isinstance(media_info, dict):
        return False

    raw_path = media_info.get('filePath') or media_info.get('path') or media_info.get('absolutePath')
    if not isinstance(raw_path, str) or not raw_path.strip():
        return False

    abs_path = os.path.abspath(os.path.expanduser(raw_path.strip()))
    if not os.path.exists(abs_path):
        print(f"transition_media_warning:missing_file:{abs_path}", flush=True)
        return False

    file_name = os.path.basename(abs_path)
    print(f"transition_media_attach:{file_name}:{abs_path}", flush=True)

    action = cue.actions.add()
    action.uuid.string = new_uuid()
    action.name = file_name
    action.label.text = file_name
    set_color(action.label.color, 0.054, 0.211, 0.588, 1.0)
    action.type = action_pb2.Action.ActionType.ACTION_TYPE_MEDIA
    action.isEnabled = True
    action.delay_time = 0.0

    media_action = action.media
    media_action.layer_type = action_pb2.Action.MediaType.LayerType.LAYER_TYPE_FOREGROUND

    element = media_action.element
    element.uuid.string = new_uuid()

    format_hint = str(media_info.get('formatHint') or '').strip().upper()
    if not format_hint:
        _, ext = os.path.splitext(file_name)
        format_hint = ext.lstrip('.').upper()
    if format_hint:
        element.metadata.format = format_hint

    absolute_uri = Path(abs_path).resolve().as_uri()
    element.url.absolute_string = absolute_uri
    element.url.platform = basicTypes_pb2.URL.Platform.PLATFORM_MACOS

    documents_root = Path.home() / 'Documents'
    rel_path = media_info.get('documentsRelativePath') if isinstance(media_info.get('documentsRelativePath'), str) else None
    if rel_path:
        rel_path = rel_path.strip().lstrip('/')
    if not rel_path and str(Path(abs_path).resolve()).startswith(str(documents_root) + os.sep):
        rel_path = os.path.relpath(abs_path, documents_root).replace(os.sep, '/')

    if rel_path:
        element.url.local.root = basicTypes_pb2.URL.LocalRelativePath.Root.Value('ROOT_USER_DOCUMENTS')
        element.url.local.path = rel_path
    else:
        element.url.local.root = basicTypes_pb2.URL.LocalRelativePath.Root.Value('ROOT_USER_HOME')
        element.url.local.path = os.path.relpath(abs_path, Path.home()).replace(os.sep, '/')

    width, height = _infer_media_dimensions(abs_path)

    image_props = element.image
    drawing = image_props.drawing
    drawing.scale_behavior = graphicsData_pb2.Media.DrawingProperties.ScaleBehavior.SCALE_BEHAVIOR_FIT
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

    if hasattr(image_props, 'file'):
        file_props = image_props.file
        local_url = file_props.local_url
        local_url.absolute_string = absolute_uri
        local_url.platform = basicTypes_pb2.URL.Platform.PLATFORM_MACOS
        if rel_path:
            local_url.local.root = basicTypes_pb2.URL.LocalRelativePath.Root.Value('ROOT_USER_DOCUMENTS')
            local_url.local.path = rel_path
        else:
            local_url.local.root = basicTypes_pb2.URL.LocalRelativePath.Root.Value('ROOT_USER_HOME')
            local_url.local.path = os.path.relpath(abs_path, Path.home()).replace(os.sep, '/')

    media_action.audio.SetInParent()

    return True


def add_media_playlist_action(cue: cue_pb2.Cue, topic: str, media_info: Optional[dict[str, Any]]) -> None:
    if not media_info or not isinstance(media_info, dict):
        return

    raw_uuid = media_info.get('uuid') or media_info.get('id') or media_info.get('mediaUuid') or media_info.get('media_uuid')
    media_uuid = str(raw_uuid or '').strip()
    if not media_uuid:
        return

    media_name = str(media_info.get('name') or media_info.get('title') or topic).strip() or topic
    playlist_uuid = str(media_info.get('playlistUuid') or media_info.get('playlist_uuid') or '').strip()
    playlist_name = str(media_info.get('playlistName') or media_info.get('playlist_name') or '').strip()

    action = cue.actions.add()
    action.uuid.string = new_uuid()
    action.name = media_name
    action.type = action_pb2.Action.ActionType.ACTION_TYPE_MEDIA_BIN_PLAYLIST
    action.isEnabled = True
    action.delay_time = 0.0
    action.label.text = ''
    set_color(action.label.color, 0.054, 0.211, 0.588, 1.0)
    action.layer_identification.uuid.string = new_uuid()
    action.layer_identification.name = 'Media'

    if playlist_uuid:
        action.playlist_item.playlist_uuid.string = playlist_uuid
    if playlist_name:
        action.playlist_item.playlist_name = playlist_name
    action.playlist_item.item_uuid.string = media_uuid
    action.playlist_item.item_name = media_name

    score_val = media_info.get('score')
    try:
        payload = {'topic': topic, 'media': media_name, 'uuid': media_uuid}
        if isinstance(score_val, (int, float)) and math.isfinite(float(score_val)):
            payload['score'] = round(float(score_val), 3)
        print(f"transition_topic_media:{json.dumps(payload)}", flush=True)
    except Exception:
        print(f"transition_topic_media:topic={topic} media={media_name}", flush=True)


def build_topic_cue(topic: str, media_info: Optional[dict[str, Any]]) -> cue_pb2.Cue:
    cue = cue_pb2.Cue()
    cue.uuid.string = new_uuid()
    cue.name = topic
    cue.isEnabled = True

    slide_action = cue.actions.add()
    slide_action.uuid.string = new_uuid()
    slide_action.name = topic
    slide_action.type = action_pb2.Action.ActionType.ACTION_TYPE_PRESENTATION_SLIDE
    slide_action.isEnabled = True
    slide_action.delay_time = 0.0
    slide_action.label.text = topic
    set_color(slide_action.label.color, 0.054, 0.211, 0.588, 1.0)
    slide_action.layer_identification.uuid.string = new_uuid()
    slide_action.layer_identification.name = "Slides"
    slide_action.slide.presentation.CopyFrom(build_transition_slide())

    attached_media = add_media_file_action(cue, media_info)
    if not attached_media:
        add_media_playlist_action(cue, topic, media_info)

    return cue


def build_clear_cue(prop_info: Optional[dict[str, Any]]) -> cue_pb2.Cue:
    print(f"DEBUG: Starting build_clear_cue with prop_info={prop_info}", flush=True)
    
    cue = cue_pb2.Cue()
    cue.uuid.string = new_uuid()
    cue.name = CLEAR_LABEL
    cue.isEnabled = True

    # Add slide action
    slide_action = cue.actions.add()
    slide_action.uuid.string = new_uuid()
    slide_action.name = CLEAR_LABEL
    slide_action.type = action_pb2.Action.ActionType.ACTION_TYPE_PRESENTATION_SLIDE
    slide_action.isEnabled = True
    slide_action.delay_time = 0.0
    slide_action.label.text = CLEAR_LABEL
    set_color(slide_action.label.color, 0.054, 0.211, 0.588, 1.0)
    slide_action.layer_identification.uuid.string = new_uuid()
    slide_action.layer_identification.name = "Slides"
    slide_action.slide.presentation.CopyFrom(build_transition_slide())

    # Add clear action
    clear_action = cue.actions.add()
    clear_action.uuid.string = new_uuid()
    clear_action.name = "Clear"
    clear_action.type = action_pb2.Action.ActionType.ACTION_TYPE_CLEAR
    clear_action.isEnabled = True
    clear_action.delay_time = 0.0
    clear_action.label.text = ''
    set_color(clear_action.label.color, 0.054, 0.211, 0.588, 1.0)
    clear_action.clear.target_layer = action_pb2.Action.ClearType.ClearTargetLayer.CLEAR_TARGET_LAYER_BACKGROUND

    try:
        if prop_info and isinstance(prop_info, dict):
            print(f"DEBUG: Creating prop action with name={CLEAR_PROP_NAME}", flush=True)
            # Add prop action for Logo
            prop_action = cue.actions.add()
            prop_action.uuid.string = new_uuid()
            prop_action.name = f"Prop • {CLEAR_PROP_NAME}"
            prop_action.type = action_pb2.Action.ActionType.ACTION_TYPE_PROP
            prop_action.isEnabled = True
            prop_action.delay_time = 0.0
            prop_action.label.text = ''
            set_color(prop_action.label.color, 0.054, 0.211, 0.588, 1.0)

            # Set up the prop identification using CollectionElementType
            if 'propUuid' in prop_info:
                prop_action.prop.identification.parameter_uuid.string = prop_info['propUuid']
                print(f"DEBUG: Set prop UUID to {prop_info['propUuid']}", flush=True)
            prop_action.prop.identification.parameter_name = CLEAR_PROP_NAME

            # Set properties from prop_info
            # The prop flags will be handled by ProPresenter's defaults
            
            print(f"DEBUG: Successfully added prop action: {prop_action}", flush=True)
    except Exception as e:
        print(f"DEBUG: Error creating prop action: {str(e)}", flush=True)
        # Continue without the prop action rather than failing completely
        print("DEBUG: Continuing without prop action", flush=True)

    return cue


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

def rebuild_transition_presentation(path: str, label: str, audience_look_name: str, timer_seconds: int, timer_info: Optional[dict[str, Any]], stage_layout_info: Optional[dict[str, Any]], topic_specs: Optional[list[dict[str, Any]]], prop_info: Optional[dict[str, Any]]) -> None:
    print(f"DEBUG: rebuild_transition called with prop_info={prop_info}", flush=True)
    package_root, target_file = locate_protobuf_payload(path)

    doc, zip_member, infos, data_map = read_presentation_bytes(target_file)
    first_cue = doc.cues[0] if doc.cues else None
    first_action = first_cue.actions[0] if first_cue and first_cue.actions else None
    print(
        "transition_template_before:" \
        f"cues={len(doc.cues)}" \
        f", actions={len(first_cue.actions) if first_cue else 0}" \
        f", label={first_action.label.text if first_action else ''}" \
        f", path={path}",
        flush=True
    )

    base_cue = cue_pb2.Cue()
    if doc.cues:
        base_cue.CopyFrom(doc.cues[0])
    else:
        base_cue.uuid.string = new_uuid()
        base_cue.name = label

    base_cue.uuid.string = new_uuid()
    base_cue.name = label
    base_cue.isEnabled = True
    base_cue.actions.clear()

    base_slide_action = base_cue.actions.add()
    base_slide_action.uuid.string = new_uuid()
    base_slide_action.name = label
    base_slide_action.type = action_pb2.Action.ActionType.ACTION_TYPE_PRESENTATION_SLIDE
    base_slide_action.isEnabled = True
    base_slide_action.delay_time = 0.0
    base_slide_action.label.text = ''
    set_color(base_slide_action.label.color, 0.054, 0.211, 0.588, 1.0)
    base_slide_action.layer_identification.uuid.string = new_uuid()
    base_slide_action.layer_identification.name = "Slides"
    base_slide_action.slide.presentation.CopyFrom(build_transition_slide())

    if timer_info:
        print(f"transition_timer_info:{json.dumps(timer_info)}", flush=True)
    if stage_layout_info:
        print(f"transition_stage_layout_info:{json.dumps(stage_layout_info)}", flush=True)

    add_audience_look_action(base_cue, audience_look_name)
    add_stage_layout_action(base_cue, stage_layout_info)
    add_countdown_timer_action(base_cue, timer_seconds, timer_info)

    topic_entries: list[tuple[str, Optional[dict[str, Any]]]] = []
    if topic_specs:
        for entry in topic_specs:
            if not isinstance(entry, dict):
                continue
            topic_text = str(entry.get('topic') or '').strip()
            if not topic_text:
                continue
            media_info = entry.get('media') if isinstance(entry.get('media'), dict) else None
            topic_entries.append((topic_text, media_info))

    if topic_entries:
        try:
            summary = [{'topic': topic, 'hasMedia': bool(media)} for topic, media in topic_entries]
            print(f"transition_topics:{json.dumps(summary)}", flush=True)
        except Exception:
            print(f"transition_topics_count:{len(topic_entries)}", flush=True)

    cues_to_write: list[cue_pb2.Cue] = [base_cue]
    for idx, (topic_text, media_payload) in enumerate(topic_entries):
        cues_to_write.append(build_topic_cue(topic_text, media_payload))
        if idx < len(topic_entries) - 1:
            cues_to_write.append(build_clear_cue(prop_info))

    doc.cues.clear()
    for cue in cues_to_write:
        doc.cues.add().CopyFrom(cue)

    # Debug log before writing
    for idx, cue in enumerate(doc.cues):
        print(f"DEBUG: Cue {idx}: {cue.name} has {len(cue.actions)} actions:", flush=True)
        for action_idx, action in enumerate(cue.actions):
            print(f"  Action {action_idx}: type={action.type} name={action.name}", flush=True)
            if action.type == action_pb2.Action.ActionType.ACTION_TYPE_PROP:
                print(f"    Prop details: name={action.prop.identification.parameter_name}", flush=True)

    written_cues = [doc.cues[idx] for idx in range(len(doc.cues))]
    group = ensure_group(doc, [cue.uuid.string for cue in written_cues], label)
    assign_group_to_slide_actions(written_cues, group.group.uuid.string, group.group.name)
    ensure_arrangement(doc, group.group.uuid.string)

    try:
        write_presentation_bytes(target_file, doc, zip_member, infos, data_map)
        print(f"DEBUG: Successfully wrote presentation to {target_file}", flush=True)
    except Exception as e:
        print(f"DEBUG: Error writing presentation: {str(e)}", flush=True)
        raise

    new_first_cue = doc.cues[0] if doc.cues else None
    new_action = new_first_cue.actions[0] if new_first_cue and new_first_cue.actions else None
    print(
        "transition_template_after:" \
        f"cues={len(doc.cues)}" \
        f", actions={len(new_first_cue.actions) if new_first_cue else 0}" \
        f", label={new_action.label.text if new_action else ''}" \
        f", path={path}",
        flush=True
    )


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(
            "Usage: python3 scripts/pp_apply_transition_template.py /path/to/file.pro [label] [audience look] [timer seconds] [timer info json] [stage layout json] [topics json] [prop info json]",
            file=sys.stderr,
        )
        return 1
    path = os.path.abspath(argv[1])
    label = argv[2] if len(argv) > 2 else LABEL_DEFAULT
    raw_look = argv[3] if len(argv) > 3 else ''
    look_name = raw_look.strip() or AUDIENCE_LOOK_DEFAULT
    timer_seconds: Optional[float] = None
    if len(argv) > 4:
        raw_timer = argv[4].strip()
        if raw_timer:
            try:
                parsed = float(raw_timer)
                if math.isfinite(parsed) and parsed > 0:
                    timer_seconds = parsed
            except ValueError:
                timer_seconds = None
    timer_info: Optional[dict[str, Any]] = None
    if len(argv) > 5:
        raw_info = argv[5].strip()
        if raw_info:
            try:
                parsed_info = json.loads(raw_info)
                if isinstance(parsed_info, dict):
                    timer_info = parsed_info
            except json.JSONDecodeError:
                timer_info = None
    stage_layout_info: Optional[dict[str, Any]] = None
    if len(argv) > 6:
        raw_stage = argv[6].strip()
        if raw_stage:
            try:
                parsed_stage = json.loads(raw_stage)
                if isinstance(parsed_stage, dict):
                    stage_layout_info = parsed_stage
            except json.JSONDecodeError:
                stage_layout_info = None
    topic_specs: Optional[list[dict[str, Any]]] = None
    if len(argv) > 7:
        raw_topics = argv[7].strip()
        if raw_topics:
            try:
                parsed_topics = json.loads(raw_topics)
                if isinstance(parsed_topics, list):
                    topic_specs = [entry for entry in parsed_topics if isinstance(entry, dict)]
            except json.JSONDecodeError:
                topic_specs = None
    prop_info: Optional[dict[str, Any]] = None
    if len(argv) > 8:
        raw_prop = argv[8].strip()
        print(f"DEBUG: Raw prop input: {raw_prop}", flush=True)
        if raw_prop:
            try:
                parsed_prop = json.loads(raw_prop)
                print(f"DEBUG: Parsed prop info: {parsed_prop}", flush=True)
                if isinstance(parsed_prop, dict):
                    prop_info = parsed_prop
                    print(f"DEBUG: Final prop info: {prop_info}", flush=True)
            except json.JSONDecodeError as e:
                print(f"DEBUG: Failed to parse prop info: {str(e)}", flush=True)
                prop_info = None
    try:
        rebuild_transition_presentation(path, label, look_name, timer_seconds, timer_info, stage_layout_info, topic_specs, prop_info)
    except Exception as exc:  # pragma: no cover - debugging aid
        print(f"error:{exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
