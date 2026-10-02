"""
Flask backend API with REST endpoints and WebSocket for live updates.
"""

import logging
import os
import sys
import hmac
import threading
import time
import traceback
from datetime import datetime
from dataclasses import asdict
from typing import Optional

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from flask_socketio import SocketIO

from config import Config
from data_providers.provider_manager import ProviderManager
from data_providers.base import OptionChainData
from indicators import calculate_indicators, IndicatorResult
from regime_detection import detect_regime, RegimeResult
from options_analysis import analyze_options, OptionsSignal
from paper_trading import PaperTrader
from backtesting import BacktestConfig, run_backtest
from data_providers.historical_options_provider import HistoricalOptionsDataError, JugaadHistoricalOptionsProvider

# ── Logging Setup ──────────────────────────────────────────────
os.makedirs("logs", exist_ok=True)
logging.basicConfig(
    level=getattr(logging, Config.LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(Config.LOG_FILE),
    ],
)
logger = logging.getLogger(__name__)

# ── App Setup ──────────────────────────────────────────────────
app = Flask(__name__, static_folder="static", static_url_path="")
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# ── Global State ───────────────────────────────────────────────
provider_manager = ProviderManager()
paper_trader = PaperTrader()

# Price history for indicator calculations (kept in memory)
price_history = {
    "NIFTY": [],
    "BANKNIFTY": [],
}

# Latest analysis cache
latest_analysis = {
    "NIFTY": {},
    "BANKNIFTY": {},
}

MAX_HISTORY = 100  # Keep last 100 price points


# ── Utility ────────────────────────────────────────────────────
def _serialize(obj):
    """Convert dataclass objects to dicts for JSON serialization."""
    if hasattr(obj, "__dataclass_fields__"):
        return asdict(obj)
    return obj


def _option_chain_to_dict(chain: Optional[OptionChainData]) -> dict:
    """Serialize option chain data, including nested option data."""
    if not chain:
        return {}

    # Only send nearby strikes (±15 around ATM)
    atm = chain.atm_strike
    filtered_strikes = []
    if atm and chain.strikes:
        for s in chain.strikes:
            if s.strike_price and abs(s.strike_price - atm) <= atm * 0.06:
                row = {
                    "strike_price": s.strike_price,
                    "expiry_date": s.expiry_date,
                }
                if s.ce:
                    row["ce"] = asdict(s.ce)
                if s.pe:
                    row["pe"] = asdict(s.pe)
                filtered_strikes.append(row)

    return {
        "symbol": chain.symbol,
        "underlying_value": chain.underlying_value,
        "timestamp": chain.timestamp,
        "expiry_dates": chain.expiry_dates,
        "atm_strike": chain.atm_strike,
        "straddle_price": chain.straddle_price,
        "pcr": chain.pcr,
        "max_pain": chain.max_pain,
        "total_ce_oi": chain.total_ce_oi,
        "total_pe_oi": chain.total_pe_oi,
        "provider": chain.provider,
        "strikes": filtered_strikes,
        "strike_count": len(chain.strikes),
    }


def run_analysis(symbol: str) -> dict:
    """Run the full analysis pipeline for a symbol."""
    result = {
        "symbol": symbol,
        "timestamp": datetime.now().isoformat(),
        "index_quote": None,
        "option_chain": {},
        "indicators": {},
        "regime": {},
        "signal": {},
        "provider": provider_manager.active_provider_name,
        "error": None,
    }

    try:
        # 1. Fetch index quote
        quote = provider_manager.get_index_quote(symbol)
        if quote:
            result["index_quote"] = _serialize(quote)
            # Add to price history
            if quote.last_price:
                history = price_history.get(symbol.upper(), [])
                history.append(quote.last_price)
                if len(history) > MAX_HISTORY:
                    history = history[-MAX_HISTORY:]
                price_history[symbol.upper()] = history

        # 2. Fetch option chain
        chain = provider_manager.get_option_chain(symbol)
        if chain:
            result["option_chain"] = _option_chain_to_dict(chain)
            # Update paper trading prices
            paper_trader.update_current_prices(chain)

        # 3. Calculate indicators
        # Use historical daily OHLC candles from provider if available
        candles = provider_manager.get_historical_candles(symbol, days=90)
        if candles and candles.get("closes"):
            prices = list(candles["closes"])
            highs = list(candles["highs"])
            lows = list(candles["lows"])
            # If today's live quote is different or extends the series, append/update today's price
            if quote and quote.last_price:
                # Update today's close with live price
                prices[-1] = quote.last_price
                if quote.high_price:
                    highs[-1] = max(highs[-1], quote.high_price)
                if quote.low_price:
                    lows[-1] = min(lows[-1], quote.low_price)
        else:
            prices = price_history.get(symbol.upper(), [])
            highs = None
            lows = None

        pcr = chain.pcr if chain else None
        total_ce_oi = chain.total_ce_oi if chain else None
        total_pe_oi = chain.total_pe_oi if chain else None

        indicators = calculate_indicators(
            prices=prices,
            highs=highs,
            lows=lows,
            pcr=pcr,
            total_ce_oi=total_ce_oi,
            total_pe_oi=total_pe_oi,
        )
        result["indicators"] = _serialize(indicators)

        # 4. Regime detection
        current_price = quote.last_price if quote else (prices[-1] if prices else None)
        regime = detect_regime(indicators, current_price)
        result["regime"] = _serialize(regime)

        # 5. Options analysis
        signal = analyze_options(regime, chain, current_price)
        result["signal"] = _serialize(signal)

        result["provider"] = provider_manager.active_provider_name

    except Exception as e:
        logger.error(f"Analysis error for {symbol}: {traceback.format_exc()}")
        result["error"] = str(e)

    latest_analysis[symbol.upper()] = result
    return result


# ── Background Data Refresh ────────────────────────────────────
def background_refresh():
    """Periodically refresh data and emit via WebSocket."""
    while True:
        try:
            for symbol in Config.DEFAULT_INDICES:
                data = run_analysis(symbol)
                socketio.emit("market_update", data)
                time.sleep(2)  # Stagger requests
        except Exception as e:
            logger.error(f"Background refresh error: {e}")
        time.sleep(Config.REFRESH_INTERVAL)


# ── REST API Routes ────────────────────────────────────────────

@app.route("/")
def serve_dashboard():
    """Serve the main dashboard."""
    return send_from_directory("static", "index.html")


@app.route("/api/analysis/<symbol>")
def api_analysis(symbol):
    """Get full analysis for a symbol."""
    symbol = symbol.upper()
    # Return cached if recent, otherwise run fresh
    cached = latest_analysis.get(symbol, {})
    if cached:
        return jsonify(cached)
    return jsonify(run_analysis(symbol))


@app.route("/api/refresh/<symbol>", methods=["POST"])
def api_refresh(symbol):
    """Force refresh analysis for a symbol."""
    symbol = symbol.upper()
    provider_manager.invalidate_cache(symbol)
    return jsonify(run_analysis(symbol))


@app.route("/api/provider/status")
def api_provider_status():
    """Get provider health status."""
    return jsonify({
        "active_provider": provider_manager.active_provider_name,
        "providers": provider_manager.get_all_health(),
    })


@app.route("/api/trades")
def api_get_trades():
    """Get all paper trades with live P&L update from latest option chain."""
    for symbol in Config.DEFAULT_INDICES:
        chain = provider_manager.get_option_chain(symbol)
        if chain:
            paper_trader.update_current_prices(chain)

    return jsonify({
        "trades": paper_trader.get_all_trades(),
        "portfolio": paper_trader.get_portfolio_summary(),
    })


@app.route("/api/trades/open")
def api_open_trades():
    for symbol in Config.DEFAULT_INDICES:
        chain = provider_manager.get_option_chain(symbol)
        if chain:
            paper_trader.update_current_prices(chain)
    return jsonify(paper_trader.get_open_trades())


@app.route("/api/trades/enter", methods=["POST"])
def api_enter_trade():
    """Enter a paper trade."""
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400

    required = ["symbol", "option_type", "strike", "premium"]
    for field in required:
        if field not in data:
            return jsonify({"error": f"Missing field: {field}"}), 400

    # Accept lots (default 1) or quantity as fallback
    lots = int(data.get("lots", data.get("quantity", 1)))
    direction = data.get("direction", "LONG")

    trade = paper_trader.enter_trade(
        symbol=data["symbol"],
        option_type=data["option_type"],
        strike=float(data["strike"]),
        expiry=data.get("expiry", ""),
        premium=float(data["premium"]),
        lots=lots,
        direction=direction,
        signal=data.get("signal", ""),
        regime=data.get("regime", ""),
        confidence=float(data.get("confidence", 0)),
    )
    return jsonify(asdict(trade))


@app.route("/api/trades/exit", methods=["POST"])
def api_exit_trade():
    """Exit a paper trade."""
    data = request.json
    if not data or "trade_id" not in data or "exit_premium" not in data:
        return jsonify({"error": "trade_id and exit_premium required"}), 400

    trade = paper_trader.exit_trade(data["trade_id"], float(data["exit_premium"]))
    if trade:
        return jsonify(asdict(trade))
    return jsonify({"error": "Trade not found or already closed"}), 404


@app.route("/api/trades/reset", methods=["POST"])
def api_reset_trades():
    """Reset all paper trades."""
    paper_trader.reset()
    return jsonify({"message": "Paper trading reset", "portfolio": paper_trader.get_portfolio_summary()})


@app.route("/api/portfolio")
def api_portfolio():
    """Get portfolio summary."""
    return jsonify(paper_trader.get_portfolio_summary())


@app.route("/api/price-history/<symbol>")
def api_price_history(symbol):
    """Get price history for a symbol."""
    symbol = symbol.upper()
    return jsonify({
        "symbol": symbol,
        "prices": price_history.get(symbol, []),
        "count": len(price_history.get(symbol, [])),
    })


@app.route("/api/backtest/<symbol>")
def api_backtest(symbol):
    """Run an isolated historical backtest; never falls back to live data."""
    try:
        lot_size = Config.get_lot_size(symbol)
        return jsonify(run_backtest(BacktestConfig(symbol=symbol.upper(), lot_size=lot_size)))
    except Exception as exc:
        logger.error("Backtest error for %s: %s", symbol, traceback.format_exc())
        return jsonify({"status": "ERROR", "message": str(exc), "metrics": {}, "trades": []}), 500


@app.route("/api/backtest/daily-options/<symbol>")
def api_daily_backtest_options(symbol):
    """Return normalized daily index-option contracts from the listing exchange."""
    expected_token = os.getenv("JUGAAD_HISTORICAL_API_TOKEN", "")
    if expected_token and not hmac.compare_digest(
        request.headers.get("Authorization", ""), f"Bearer {expected_token}"
    ):
        return jsonify({"error": "Unauthorized historical options service request."}), 401
    from_date = request.args.get("from", "")
    to_date = request.args.get("to", "")
    try:
        dataset = JugaadHistoricalOptionsProvider().get_data(symbol, from_date, to_date)
        return jsonify(dataset)
    except HistoricalOptionsDataError as exc:
        message = str(exc)
        status = 502 if "Jugaad/NSE historical requests failed" in message else 422
        return jsonify({"error": message}), status
    except Exception as exc:
        logger.exception("Daily historical options request failed for %s", symbol)
        return jsonify({"error": f"Could not load historical exchange options: {exc}"}), 502


# ── WebSocket Events ──────────────────────────────────────────

@socketio.on("connect")
def handle_connect():
    logger.info("Client connected via WebSocket")
    # Send latest data immediately
    for symbol in Config.DEFAULT_INDICES:
        cached = latest_analysis.get(symbol, {})
        if cached:
            socketio.emit("market_update", cached)


@socketio.on("request_refresh")
def handle_refresh_request(data):
    symbol = data.get("symbol", Config.DEFAULT_INDEX)
    provider_manager.invalidate_cache(symbol)
    result = run_analysis(symbol)
    socketio.emit("market_update", result)


# ── Main ───────────────────────────────────────────────────────
if __name__ == "__main__":
    logger.info("=" * 60)
    logger.info("Starting Indian Stock/Options Analysis System")
    logger.info(f"Dashboard: http://localhost:{Config.PORT}")
    logger.info(f"Symbols: {Config.DEFAULT_INDICES}")
    logger.info(f"Refresh interval: {Config.REFRESH_INTERVAL}s")
    logger.info("=" * 60)
    logger.info("⚠ PAPER TRADING ONLY — No real orders will be placed")
    logger.info("=" * 60)

    # Run initial analysis
    for symbol in Config.DEFAULT_INDICES:
        try:
            logger.info(f"Running initial analysis for {symbol}...")
            run_analysis(symbol)
        except Exception as e:
            logger.error(f"Initial analysis failed for {symbol}: {e}")

    # Start background refresh thread
    refresh_thread = threading.Thread(target=background_refresh, daemon=True)
    refresh_thread.start()

    socketio.run(app, host=Config.HOST, port=Config.PORT, debug=Config.DEBUG,
                 allow_unsafe_werkzeug=True)
