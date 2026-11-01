-- One row per scored service day: the full scoreboard summary as JSON.
CREATE TABLE IF NOT EXISTS days (
  date TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  created INTEGER NOT NULL
);

-- Observed arrivals, one row per trip per day: [[stop_sequence, unix_time, +/- seconds], ...].
CREATE TABLE IF NOT EXISTS arrivals (
  date TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  route TEXT,
  stops TEXT NOT NULL,
  PRIMARY KEY (date, trip_id)
);
