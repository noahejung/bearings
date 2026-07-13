import json
import sys

from bearings import geocode, profile


def main() -> int:
    if len(sys.argv) < 3 or sys.argv[1] != "profile":
        print('usage: bearings profile "<nyc address>"', file=sys.stderr)
        return 2

    try:
        result = profile.profile_for(" ".join(sys.argv[2:]))
    except geocode.GeocodeError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
