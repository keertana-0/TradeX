"""JSON command bridge used by the Next.js backtest route."""

import json
import sys

from data_providers.historical_options_provider import JugaadHistoricalOptionsProvider


def main() -> int:
    if len(sys.argv) != 4:
        print("Usage: get_historical_options.py SYMBOL FROM_DATE TO_DATE", file=sys.stderr)
        return 2
    symbol, from_date, to_date = sys.argv[1:]
    try:
        result = JugaadHistoricalOptionsProvider().get_data(symbol, from_date, to_date)
        print(json.dumps(result, allow_nan=False, separators=(",", ":")))
        return 0
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
