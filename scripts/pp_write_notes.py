import argparse
import os
import sys
from google.protobuf.message import DecodeError

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, '..'))

if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

# Add generated folder to sys.path so imports like action_pb2 work
gen_dir = os.path.join(PROJECT_ROOT, 'src', 'gen')
sys.path.insert(0, os.path.abspath(gen_dir))

from pb_runtime_compat import ensure_protobuf_runtime, relax_protobuf_runtime_check

try:
    from pp_apply_transition_template import (
        rebuild_transition_presentation,
        LABEL_DEFAULT as TRANSITION_LABEL,
        AUDIENCE_LOOK_DEFAULT as TRANSITION_LOOK,
    )
except ImportError:  # pragma: no cover - helper script missing
    rebuild_transition_presentation = None  # type: ignore
    TRANSITION_LABEL = "Background & Lights"
    TRANSITION_LOOK = "Full Screen Media"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Overwrite operator notes in a ProPresenter presentation."
    )
    parser.add_argument("pro_file", help="Path to the .pro presentation file (or bundle)")
    parser.add_argument(
        "notes",
        nargs='+',
        help="Operator notes text (wrap in quotes to include spaces)",
    )
    parser.add_argument(
        "--designation",
        help="If set to 'transition', also rebuild the presentation using the transition template",
    )
    return parser.parse_args(argv[1:])


def main(argv: list[str]) -> int:
    args = parse_args(argv)

    pro_file = os.path.expanduser(args.pro_file)
    notes = " ".join(args.notes)

    ok, detail = ensure_protobuf_runtime()
    if not ok:
        raise SystemExit(f"protobuf runtime not available: {detail}")

    relax_protobuf_runtime_check()

    import presentation_pb2  # generated from presentation.proto

    doc = presentation_pb2.Presentation()
    with open(pro_file, "rb") as f:
        data = f.read()

    try:
        doc.ParseFromString(data)
    except DecodeError:
        print(
            "ERROR: Could not parse the .pro file. Is this a Presentation document? Is ProPresenter closed?",
            file=sys.stderr,
        )
        raise

    print("Current operator notes:", repr(doc.notes))
    doc.notes = notes  # overwrite; append mode can be enabled later

    with open(pro_file, "wb") as f:
        f.write(doc.SerializeToString())

    print("✅ Wrote operator notes to:", pro_file)
    print("New operator notes:", repr(notes))

    designation = (args.designation or '').strip().lower() if args.designation else ''
    if designation == 'transition':
        if rebuild_transition_presentation is None:
            print(
                "⚠️ Transition designation set but transition template helper is unavailable.",
                file=sys.stderr,
            )
        else:
            try:
                rebuild_transition_presentation(pro_file, TRANSITION_LABEL, TRANSITION_LOOK)
                print("✅ Transition presentation rebuilt with template:", TRANSITION_LABEL)
            except Exception as exc:  # pragma: no cover - runtime safety
                print(f"⚠️ Failed to rebuild transition presentation: {exc}", file=sys.stderr)

    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
