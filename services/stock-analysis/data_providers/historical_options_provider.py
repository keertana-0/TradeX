"""Historical daily NSE index-option observations from jugaad-data.

Jugaad's derivatives archive is end-of-day data. Every returned quote is dated
to its trading session and contains that session's OHLC values; this module
never manufactures intraday timestamps or prices.
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta
from io import StringIO
from pathlib import Path
from typing import Any

import pandas as pd

logger = logging.getLogger(__name__)

INDEX_SYMBOLS = {
    "NIFTY50": {"jugaad": "NIFTY", "index_name": "NIFTY 50", "instrument": "OPTIDX"},
    "NIFTY": {"jugaad": "NIFTY", "index_name": "NIFTY 50", "instrument": "OPTIDX"},
    "BANKNIFTY": {"jugaad": "BANKNIFTY", "index_name": "NIFTY BANK", "instrument": "OPTIDX"},
    "SENSEX": {"jugaad": "SENSEX", "index_name": "SENSEX", "instrument": "OPTIDX"},
}
REQUIRED_FIELDS = {"date", "underlying", "expiry", "strike", "optionType", "open", "high", "low", "close", "volume", "oi", "underlyingPrice"}


class HistoricalOptionsDataError(ValueError):
    """Raised when genuine daily options observations cannot be returned."""


def _download_bse_bhavcopy(trading_day: date) -> str:
    """Download BSE's published UDiFF F&O bhavcopy for the requested session."""
    import requests

    ymd = trading_day.strftime("%Y%m%d")
    url = f"https://www.bseindia.com/download/Bhavcopy/Derivative/BhavCopy_BSE_FO_0_0_0_{ymd}_F_0000.csv"
    response = requests.get(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
        "Referer": "https://www.bseindia.com/markets/Derivatives/DeriReports/DeriBhavCopy.aspx",
    }, timeout=30)
    response.raise_for_status()
    raw = response.content.decode("utf-8-sig", errors="replace")
    if not raw.lstrip().startswith("TradDt,"):
        raise ValueError("BSE returned an unavailable or invalid F&O bhavcopy file.")
    return raw


def _expiry_date(value: Any) -> date | None:
    text = str(value).strip()
    if len(text) >= 10 and text[4:5] == "-" and text[7:8] == "-":
        try:
            return date.fromisoformat(text[:10])
        except ValueError:
            return None
    parsed = pd.to_datetime(value, errors="coerce", dayfirst=True)
    return None if pd.isna(parsed) else parsed.date()


def _number(value: Any, *, positive: bool = False) -> float | None:
    parsed = pd.to_numeric(value, errors="coerce")
    if pd.isna(parsed) or not pd.notna(parsed):
        return None
    result = float(parsed)
    if result < 0 or (positive and result <= 0):
        return None
    return result


def _signed_number(value: Any) -> float | None:
    parsed = pd.to_numeric(value, errors="coerce")
    return None if pd.isna(parsed) else float(parsed)


def _empty_quality() -> dict[str, Any]:
    return {"rawCandidateRows": 0, "acceptedRows": 0, "rejectedRows": 0, "rejectionCounts": {}}


def _merge_quality(target: dict[str, Any], source: dict[str, Any]) -> None:
    for field in ("rawCandidateRows", "acceptedRows", "rejectedRows"):
        target[field] = int(target.get(field, 0)) + int(source.get(field, 0))
    for reason, count in source.get("rejectionCounts", {}).items():
        target["rejectionCounts"][reason] = target["rejectionCounts"].get(reason, 0) + int(count)


def normalize_bhavcopy(
    raw: str,
    requested_symbol: str,
    trading_day: date,
    legacy_spot: float | None = None,
    quality: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Normalize Jugaad's legacy and UDiFF F&O bhavcopy layouts."""
    try:
        source = pd.read_csv(StringIO(raw), dtype=str)
    except Exception as exc:
        raise HistoricalOptionsDataError(f"Could not parse Jugaad F&O bhavcopy for {trading_day}: {exc}") from exc
    if source.empty:
        return []
    source.columns = [str(column).strip() for column in source.columns]
    upper = {column.upper(): column for column in source.columns}

    def column(*names: str) -> str | None:
        return next((upper[name.upper()] for name in names if name.upper() in upper), None)

    modern = "TCKRSYMB" in upper
    symbol_col = column("TckrSymb" if modern else "SYMBOL")
    instrument_col = column("FinInstrmTp" if modern else "INSTRUMENT")
    date_col = column("TradDt" if modern else "TIMESTAMP", "DATE")
    expiry_col = column("XpryDt" if modern else "EXPIRY_DT", "EXPIRY")
    option_col = column("OptnTp" if modern else "OPTION_TYP", "OPTION TYPE")
    strike_col = column("StrkPric" if modern else "STRIKE_PR", "STRIKE PRICE")
    open_col = column("OpnPric" if modern else "OPEN", "OPEN PRICE")
    high_col = column("HghPric" if modern else "HIGH", "HIGH PRICE")
    low_col = column("LwPric" if modern else "LOW", "LOW PRICE")
    close_col = column("ClsPric" if modern else "CLOSE", "CLOSE PRICE")
    ltp_col = column("LastPric" if modern else "LAST", "LTP")
    volume_col = column("TtlTradgVol" if modern else "CONTRACTS", "TOTAL TRADED QUANTITY", "VOLUME")
    oi_col = column("OpnIntrst" if modern else "OPEN_INT", "OPEN INTEREST")
    change_oi_col = column("ChngInOpnIntrst" if modern else "CHG_IN_OI", "CHANGE IN OI")
    spot_col = column("UndrlygPric", "UNDERLYING_VALUE", "UNDERLYING PRICE")
    needed = [symbol_col, instrument_col, date_col, expiry_col, option_col, strike_col, close_col]
    if any(item is None for item in needed):
        raise HistoricalOptionsDataError(f"Jugaad F&O response for {trading_day} is missing required contract columns.")

    metadata = INDEX_SYMBOLS[requested_symbol]
    symbol_values = source[symbol_col].astype(str).str.strip().str.upper()
    instrument_values = source[instrument_col].astype(str).str.strip().str.upper()
    expected_instrument = "IDO" if modern else metadata["instrument"]
    rows = source[(symbol_values == metadata["jugaad"]) & (instrument_values == expected_instrument)]
    if quality is not None:
        quality["rawCandidateRows"] = quality.get("rawCandidateRows", 0) + len(rows)
    observations: list[dict[str, Any]] = []
    for _, row in rows.iterrows():
        day_value = pd.to_datetime(row[date_col], errors="coerce", dayfirst=not modern)
        expiry = _expiry_date(row[expiry_col])
        option_type = str(row[option_col]).strip().upper()
        strike = _number(row[strike_col], positive=True)
        close = _number(row[close_col], positive=True)
        open_price = _number(row[open_col], positive=True) if open_col else None
        high = _number(row[high_col], positive=True) if high_col else None
        low = _number(row[low_col], positive=True) if low_col else None
        volume = _number(row[volume_col]) if volume_col else None
        spot = _number(row[spot_col], positive=True) if spot_col else legacy_spot
        reason = None
        if pd.isna(day_value) or day_value.date() != trading_day:
            reason = "wrong_or_invalid_trade_date"
        elif expiry is None or expiry < trading_day or option_type not in {"CE", "PE"} or strike is None or spot is None:
            reason = "invalid_contract_or_underlying"
        elif open_price is None or high is None or low is None or close is None:
            reason = "incomplete_ohlc"
        elif low > high or open_price < low or open_price > high or close < low or close > high:
            # Some expiry-day BSE rows have the underlying index level copied
            # into the option close. Reject the full bar before backtesting.
            reason = "inconsistent_ohlc"
        elif volume is None:
            reason = "missing_volume"
        elif volume <= 0:
            reason = "no_traded_volume"
        if reason:
            if quality is not None:
                quality["rejectedRows"] = quality.get("rejectedRows", 0) + 1
                counts = quality.setdefault("rejectionCounts", {})
                counts[reason] = counts.get(reason, 0) + 1
            continue
        ltp = _number(row[ltp_col], positive=True) if ltp_col else close
        observations.append({
            "date": trading_day.isoformat(), "underlying": requested_symbol,
            "expiry": expiry.isoformat(), "strike": strike, "optionType": option_type,
            "open": open_price, "high": high, "low": low, "close": close,
            "ltp": ltp or close,
            "volume": volume,
            "oi": _number(row[oi_col]) if oi_col else None,
            "changeOi": _signed_number(row[change_oi_col]) if change_oi_col else None,
            "underlyingPrice": spot,
        })
    deduped: dict[tuple[str, float, str], dict[str, Any]] = {}
    for observation in observations:
        key = (observation["expiry"], observation["strike"], observation["optionType"])
        prior = deduped.get(key)
        if prior and prior != observation:
            raise HistoricalOptionsDataError(f"Jugaad returned conflicting duplicate observations for {requested_symbol} {key} on {trading_day}.")
        deduped[key] = observation
    if quality is not None:
        quality["acceptedRows"] = quality.get("acceptedRows", 0) + len(deduped)
        duplicate_count = len(observations) - len(deduped)
        if duplicate_count:
            quality["rejectedRows"] = quality.get("rejectedRows", 0) + duplicate_count
            counts = quality.setdefault("rejectionCounts", {})
            counts["duplicate_contract_rows"] = counts.get("duplicate_contract_rows", 0) + duplicate_count
    return sorted(deduped.values(), key=lambda item: (item["expiry"], item["strike"], item["optionType"]))


class JugaadHistoricalOptionsProvider:
    """Fetch and locally cache real, daily option-chain observations."""

    def __init__(self, cache_dir: Path | None = None):
        self.cache_dir = cache_dir or Path(__file__).resolve().parents[2] / ".cache" / "jugaad-options"

    def get_data(self, symbol: str, from_date: str, to_date: str) -> dict[str, Any]:
        key = symbol.strip().upper()
        if key not in INDEX_SYMBOLS:
            raise HistoricalOptionsDataError(f"Unsupported Jugaad index option symbol: {symbol}.")
        try:
            start, end = date.fromisoformat(from_date), date.fromisoformat(to_date)
        except ValueError as exc:
            raise HistoricalOptionsDataError("Historical options require valid ISO start and end dates.") from exc
        if start > end:
            raise HistoricalOptionsDataError("The historical options start date must be on or before the end date.")
        if end > date.today():
            raise HistoricalOptionsDataError("Historical options cannot be requested for future dates.")
        if (end - start).days > 187:
            raise HistoricalOptionsDataError("A single automatic backtest request is limited to 180 calendar days, with up to seven extra calendar days for the prior-session signal price.")

        try:
            from jugaad_data.nse import bhavcopy_fo_raw, index_df
        except ImportError as exc:
            raise HistoricalOptionsDataError("jugaad-data is not installed in the stock-analysis Python environment.") from exc

        self.cache_dir.mkdir(parents=True, exist_ok=True)
        dates = [start + timedelta(days=offset) for offset in range((end - start).days + 1)]
        raw_by_date: dict[date, str] = {}
        provider_errors: dict[date, str] = {}
        legacy_dates: list[date] = []
        cached: dict[date, tuple[list[dict[str, Any]], dict[str, Any]]] = {}
        for day in dates:
            if day.weekday() >= 5:
                continue
            cache_file = self.cache_dir / f"v4-{key}-{day.isoformat()}.json"
            if cache_file.is_file():
                try:
                    payload = json.loads(cache_file.read_text(encoding="utf-8"))
                    if isinstance(payload, dict) and isinstance(payload.get("observations"), list) and isinstance(payload.get("quality"), dict):
                        cached[day] = (payload["observations"], payload["quality"])
                        continue
                except (OSError, json.JSONDecodeError):
                    pass
            try:
                raw = _download_bse_bhavcopy(day) if key == "SENSEX" else bhavcopy_fo_raw(day)
                raw_by_date[day] = raw
                headers = {str(column).strip().upper() for column in pd.read_csv(StringIO(raw), nrows=0).columns}
                if not headers.intersection({"UNDRLYGPRIC", "UNDERLYING_VALUE", "UNDERLYING PRICE"}):
                    legacy_dates.append(day)
            except Exception as exc:
                provider_errors[day] = str(exc)

        spots: dict[date, float] = {}
        if legacy_dates:
            try:
                index_history = index_df(
                    INDEX_SYMBOLS[key]["index_name"], min(legacy_dates), max(legacy_dates)
                )
                date_column = "HistoricalDate" if "HistoricalDate" in index_history.columns else "DATE"
                for _, row in index_history.iterrows():
                    parsed_day = pd.to_datetime(row[date_column], errors="coerce", dayfirst=True)
                    spot = _number(row.get("CLOSE"), positive=True)
                    if pd.notna(parsed_day) and spot is not None:
                        spots[parsed_day.date()] = spot
            except Exception as exc:
                logger.info("Index history lookup unavailable; UDiFF option rows may include underlying price: %s", exc)

        observations: list[dict[str, Any]] = []
        quality_totals = _empty_quality()
        errors = [f"{day.isoformat()}: {message}" for day, message in provider_errors.items()]
        for day in dates:
            if day in cached:
                day_rows, day_quality = cached[day]
                observations.extend(day_rows)
                _merge_quality(quality_totals, day_quality)
                continue
            if day not in raw_by_date:
                continue
            try:
                day_quality = _empty_quality()
                day_rows = normalize_bhavcopy(raw_by_date[day], key, day, spots.get(day), day_quality)
                cache_file = self.cache_dir / f"v4-{key}-{day.isoformat()}.json"
                cache_file.write_text(json.dumps({"observations": day_rows, "quality": day_quality}, allow_nan=False), encoding="utf-8")
                observations.extend(day_rows)
                _merge_quality(quality_totals, day_quality)
            except Exception as exc:
                errors.append(f"{day.isoformat()}: {exc}")
                logger.warning("Could not fetch Jugaad options for %s on %s: %s", key, day, exc)

        if not observations and end == date.today() and errors:
            exchange = "BSE" if key == "SENSEX" else "NSE"
            raise HistoricalOptionsDataError(
                f"The {exchange} final end-of-day options report for {end.isoformat()} is not available yet. "
                "A daily backtest needs completed OHLC data; try again after the exchange publishes today's final bhavcopy, "
                "or select the latest completed trading session."
            )
        if not observations:
            if errors:
                raise HistoricalOptionsDataError(f"Jugaad/NSE historical requests failed for {key} from {start} through {end}. First provider error: {errors[0]}")
            if quality_totals["rejectedRows"]:
                reasons = ", ".join(f"{reason}: {count}" for reason, count in sorted(quality_totals["rejectionCounts"].items()))
                raise HistoricalOptionsDataError(
                    f"No clean daily option bars were available for {key} from {start} through {end}. "
                    f"Rejected {quality_totals['rejectedRows']} of {quality_totals['rawCandidateRows']} candidate rows ({reasons})."
                )
            raise HistoricalOptionsDataError(f"No historical daily option contracts were available for {key} from {start} through {end}.")
        return {
            "provider": "bseindia" if key == "SENSEX" else "jugaad-data", "granularity": "daily",
            "observations": observations,
            "quality": quality_totals,
            "coverage": {"requestedFrom": from_date, "requestedTo": to_date, "observedSessions": len({row["date"] for row in observations}), "failedDateCount": len(errors), "failedDates": errors[:20]},
        }
