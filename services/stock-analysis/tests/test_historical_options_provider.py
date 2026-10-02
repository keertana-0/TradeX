import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

import pandas as pd

from data_providers.historical_options_provider import (
    HistoricalOptionsDataError,
    JugaadHistoricalOptionsProvider,
    normalize_bhavcopy,
)


LEGACY = """INSTRUMENT,SYMBOL,TIMESTAMP,EXPIRY_DT,OPTION_TYP,STRIKE_PR,OPEN,HIGH,LOW,CLOSE,CONTRACTS,OPEN_INT,CHG_IN_OI
OPTIDX,NIFTY,01-Jan-2025,30-Jan-2025,CE,23000,100,120,90,110,10,1000,-25
OPTIDX,NIFTY,01-Jan-2025,30-Jan-2025,PE,23000,105,125,95,115,12,1100,30
"""

UDIFF = """FinInstrmTp,TckrSymb,TradDt,XpryDt,OptnTp,StrkPric,OpnPric,HghPric,LwPric,ClsPric,LastPric,TtlTradgVol,OpnIntrst,ChngInOpnIntrst,UndrlygPric
IDO,NIFTY,2025-01-01,2025-01-30,CE,23000,100,120,90,110,111,10,1000,-25,23010
"""

CORRUPT_BSE_EXPIRY = """FinInstrmTp,TckrSymb,TradDt,XpryDt,OptnTp,StrkPric,OpnPric,HghPric,LwPric,ClsPric,LastPric,TtlTradgVol,OpnIntrst,ChngInOpnIntrst,UndrlygPric
IDO,SENSEX,2026-09-03,2026-09-03,CE,76400,330,547.50,0.05,76152.86,0.05,72031120,1220,1220,76152.86
IDO,SENSEX,2026-09-03,2026-09-10,CE,76400,765.60,878.70,530.50,591.80,530.50,140520,100,10,76152.86
"""

BSE_UDIFF = """TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol
2025-01-01,2025-01-01,FO,BSE,IDO,123,,SENSEX,,2025-01-07,2025-01-07,78000,CE,SENSEX,110,120,90,115,115,100,78050,115,1000,25,10
"""


class NormalizeBhavcopyTests(unittest.TestCase):
    def test_normalizes_legacy_expiry_strike_sides_and_signed_change_in_oi(self):
        rows = normalize_bhavcopy(LEGACY, "NIFTY50", date(2025, 1, 1), 23010)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["expiry"], "2025-01-30")
        self.assertEqual(rows[0]["strike"], 23000)
        self.assertEqual(rows[0]["optionType"], "CE")
        self.assertEqual(rows[0]["close"], 110)
        self.assertEqual(rows[0]["changeOi"], -25)
        self.assertEqual(rows[0]["underlyingPrice"], 23010)

    def test_normalizes_udiff_response_with_its_historical_underlying_price(self):
        rows = normalize_bhavcopy(UDIFF, "NIFTY50", date(2025, 1, 1))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["underlyingPrice"], 23010)
        self.assertEqual(rows[0]["ltp"], 111)

    def test_ignores_other_symbols_instead_of_mixing_contracts(self):
        raw = LEGACY.replace("OPTIDX,NIFTY,", "OPTIDX,BANKNIFTY,")
        self.assertEqual(normalize_bhavcopy(raw, "NIFTY50", date(2025, 1, 1), 23010), [])

    def test_drops_contracts_without_daily_trading_volume(self):
        raw = LEGACY.replace(",10,1000,-25", ",0,1000,-25")
        rows = normalize_bhavcopy(raw, "NIFTY50", date(2025, 1, 1), 23010)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["optionType"], "PE")

    def test_drops_traded_rows_with_incomplete_ohlc(self):
        raw = UDIFF.replace(",23000,100,120,90,110,111,", ",23000,,120,90,110,111,")
        quality = {"rawCandidateRows": 0, "acceptedRows": 0, "rejectedRows": 0, "rejectionCounts": {}}
        rows = normalize_bhavcopy(raw, "NIFTY50", date(2025, 1, 1), quality=quality)
        self.assertEqual(rows, [])
        self.assertEqual(quality["rejectionCounts"]["incomplete_ohlc"], 1)

    def test_reports_malformed_response_columns(self):
        with self.assertRaisesRegex(HistoricalOptionsDataError, "missing required contract columns"):
            normalize_bhavcopy("bad,column\n1,2\n", "NIFTY50", date(2025, 1, 1))


class JugaadProviderTests(unittest.TestCase):
    def test_cache_hit_avoids_nse_requests(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / "v4-NIFTY50-2025-01-01.json"
            cache.write_text(json.dumps({"observations": normalize_bhavcopy(UDIFF, "NIFTY50", date(2025, 1, 1)), "quality": {"rawCandidateRows": 1, "acceptedRows": 1, "rejectedRows": 0, "rejectionCounts": {}}}), encoding="utf-8")
            with patch("jugaad_data.nse.bhavcopy_fo_raw") as download:
                result = JugaadHistoricalOptionsProvider(Path(directory)).get_data("NIFTY50", "2025-01-01", "2025-01-01")
            download.assert_not_called()
            self.assertEqual(result["provider"], "jugaad-data")
            self.assertEqual(result["granularity"], "daily")
            self.assertEqual(len(result["observations"]), 1)
            self.assertEqual(result["quality"]["acceptedRows"], 1)

    def test_cache_miss_fetches_and_caches_daily_bhavcopy(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch("jugaad_data.nse.bhavcopy_fo_raw", return_value=UDIFF) as download, patch(
                "jugaad_data.nse.index_df", return_value=pd.DataFrame()
            ):
                result = JugaadHistoricalOptionsProvider(Path(directory)).get_data("NIFTY50", "2025-01-01", "2025-01-01")
            download.assert_called_once_with(date(2025, 1, 1))
            self.assertTrue((Path(directory) / "v4-NIFTY50-2025-01-01.json").is_file())
            self.assertEqual(result["observations"][0]["close"], 110)
            self.assertEqual(result["quality"]["rawCandidateRows"], 1)

    def test_legacy_contracts_use_the_matching_historical_index_close(self):
        with tempfile.TemporaryDirectory() as directory, patch(
            "jugaad_data.nse.bhavcopy_fo_raw", return_value=LEGACY
        ), patch(
            "jugaad_data.nse.index_df",
            return_value=pd.DataFrame({"HistoricalDate": [date(2025, 1, 1)], "CLOSE": [23010]}),
        ) as index_history:
            result = JugaadHistoricalOptionsProvider(Path(directory)).get_data("NIFTY50", "2025-01-01", "2025-01-01")
        index_history.assert_called_once_with("NIFTY 50", date(2025, 1, 1), date(2025, 1, 1))
        self.assertEqual(len(result["observations"]), 2)
        self.assertTrue(all(row["underlyingPrice"] == 23010 for row in result["observations"]))

    def test_empty_nse_response_reports_no_historical_contracts(self):
        with tempfile.TemporaryDirectory() as directory, patch(
            "jugaad_data.nse.bhavcopy_fo_raw", return_value="INSTRUMENT,SYMBOL\n"
        ), patch("jugaad_data.nse.index_df", return_value=pd.DataFrame()):
            with self.assertRaisesRegex(HistoricalOptionsDataError, "No historical daily option contracts"):
                JugaadHistoricalOptionsProvider(Path(directory)).get_data("NIFTY50", "2025-01-01", "2025-01-01")

    def test_nse_failure_is_reported_instead_of_becoming_empty_data(self):
        with tempfile.TemporaryDirectory() as directory, patch(
            "jugaad_data.nse.bhavcopy_fo_raw", side_effect=RuntimeError("NSE temporarily unavailable")
        ):
            with self.assertRaisesRegex(HistoricalOptionsDataError, "Jugaad/NSE historical requests failed.*NSE temporarily unavailable"):
                JugaadHistoricalOptionsProvider(Path(directory)).get_data("NIFTY50", "2025-01-01", "2025-01-01")

    def test_normalizes_bse_sensex_udiff_contract(self):
        rows = normalize_bhavcopy(BSE_UDIFF, "SENSEX", date(2025, 1, 1))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["underlying"], "SENSEX")
        self.assertEqual(rows[0]["underlyingPrice"], 78050)
        self.assertEqual(rows[0]["optionType"], "CE")

    def test_drops_bse_option_rows_with_close_outside_daily_high_low(self):
        quality = {"rawCandidateRows": 0, "acceptedRows": 0, "rejectedRows": 0, "rejectionCounts": {}}
        rows = normalize_bhavcopy(CORRUPT_BSE_EXPIRY, "SENSEX", date(2026, 9, 3), quality=quality)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["expiry"], "2026-09-10")
        self.assertEqual(rows[0]["close"], 591.8)
        self.assertEqual(quality["rawCandidateRows"], 2)
        self.assertEqual(quality["acceptedRows"], 1)
        self.assertEqual(quality["rejectedRows"], 1)
        self.assertEqual(quality["rejectionCounts"]["inconsistent_ohlc"], 1)

    def test_fetches_sensex_from_bse_daily_derivatives_report(self):
        with tempfile.TemporaryDirectory() as directory, patch(
            "data_providers.historical_options_provider._download_bse_bhavcopy", return_value=BSE_UDIFF
        ) as download:
            result = JugaadHistoricalOptionsProvider(Path(directory)).get_data("SENSEX", "2025-01-01", "2025-01-01")
        download.assert_called_once_with(date(2025, 1, 1))
        self.assertEqual(result["provider"], "bseindia")
        self.assertEqual(len(result["observations"]), 1)

    def test_old_cache_is_ignored_after_quality_validation_upgrade(self):
        with tempfile.TemporaryDirectory() as directory:
            stale = Path(directory) / "v3-SENSEX-2026-09-03.json"
            stale.write_text(json.dumps([{"date": "2026-09-03", "underlying": "SENSEX", "expiry": "2026-09-03", "strike": 76400, "optionType": "CE", "open": 330, "high": 547.5, "low": 0.05, "close": 76152.86, "ltp": 0.05, "volume": 72031120, "underlyingPrice": 76152.86}]), encoding="utf-8")
            with patch("data_providers.historical_options_provider._download_bse_bhavcopy", return_value=CORRUPT_BSE_EXPIRY) as download:
                result = JugaadHistoricalOptionsProvider(Path(directory)).get_data("SENSEX", "2026-09-03", "2026-09-03")
            download.assert_called_once_with(date(2026, 9, 3))
            self.assertTrue(all(row["close"] < 10_000 for row in result["observations"]))
            self.assertEqual(result["quality"]["rejectedRows"], 1)


if __name__ == "__main__":
    unittest.main()
