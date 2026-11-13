# bide

**A live 3D map of Victoria, BC, and an honest daily test of bus arrival predictions.**

**→ [bide.tgoyal.me](https://bide.tgoyal.me)**

Every bus in Greater Victoria moves on a hand-built 3D model of the city. Underneath it, a recorder keeps every bus position and every arrival prediction BC Transit publishes. Each night those predictions are scored against when the buses actually arrived, side by side with bide's own model.

## The result

bide+ is bide's blended model. It has been closer than BC Transit's own predictions every day from 4 to 12 November 2026, nine days in a row.

| Day | BC Transit | bide+ | Arrivals scored |
|---|---|---|---|
| 12 Nov | 1:31 | **1:25** | 99,070 |
| 11 Nov | 1:15 | **1:11** | 70,968 |
| 10 Nov | 1:24 | **1:18** | 103,340 |
| 9 Nov | 1:20 | **1:15** | 103,382 |
| 4–12 Nov, average | 1:21 | **1:17** | |

The times are mean absolute error: on average, how far off the predicted arrival was. The full history, broken down by lead time and route, is on the site's scoreboard.

How the comparison is kept fair:
- **Same everything.** Both models are scored on the same trips, at the same stops, from the same moment, against the same observed arrivals. That's around 2.8 million predictions on a normal weekday.
- **No peeking.** bide+'s settings are fitted only on earlier days, never the day being scored.
- **Clock errors are fixed for both.** On 1 November (the end of daylight saving), BC Transit's feed put every time one hour out. That error is corrected for BC Transit's predictions as well as bide's, so neither wins on a technicality.

## The models

Both live in [`shared/model.js`](shared/model.js). The nightly scorer and the live bus cards on the map run exactly this code.

- **bide**: delay persistence. A bus that is three minutes late now will probably still be late at its next stops, but less so further ahead. The model learns from earlier days how quickly lateness fades.
- **bide+**: a blend of BC Transit's prediction, bide's and the timetable. It uses separate weights for each band of lead time (under 2 minutes, 2–5 minutes, and so on), fitted by least absolute error on the three previous normal days.

The main finding so far: BC Transit's predictions lean early. A bus predicted 20 to 30 minutes out arrives about three minutes after its predicted time, on average. bide+ mostly wins by correcting that lean.

## The map

The map is three.js with custom shaders and no map library.

- **The city**: land, parks and streets come from OpenStreetMap. Hills come from open elevation data. The buildings are extruded from OpenStreetMap footprints. The sea's foam follows the real coastline. Light follows the real sun and moon over Victoria.
- **Buses**: decoded from BC Transit's GTFS-Realtime feed. Each one is played back along its own route's shape, so it follows the roads and turns where they turn. Colour them by lateness, crowding or route.
- **Tap a bus** for its next stops: BC Transit's predicted time next to bide's.
- **Tap a stop** for a departures board of every bus due there in the next 75 minutes.
- **Bunching**: two buses on the same route closer than 350 m are flagged.
- **Live layers**, each one can be switched off:
  - weather, wind and sea state;
  - air quality;
  - Environment Canada warnings;
  - tides;
  - earthquakes;
  - DriveBC road works;
  - BC Hydro outages;
  - local news.

## How it runs

```
BC Transit GTFS-RT ──► Cloudflare Worker + Durable Object (SQLite)
                         │  polls vehicles every 10 s, predictions every minute
                         │  serves /api/* and the site
                         ▼
             GitHub Actions, nightly ──► scores the day ──► D1 ──► scoreboard
             GitHub Actions, daily   ──► health check (fails loudly if anything is stale)
             GitHub Actions, weekly  ──► re-bakes the timetable, deploys if it changed
```

- [`worker/`](worker): the recorder and API. One Worker serves both, and stores compact gzipped snapshots, kept for 30 days.
- [`shared/gtfsrt.js`](shared/gtfsrt.js): a small protobuf reader. It decodes a GTFS-Realtime feed in about 3 ms, which keeps the recorder inside the free plan's CPU limit.
- [`pipeline/`](pipeline): the nightly scorer and the health check.
- [`scripts/`](scripts): bakes the timetable, map, buildings and street names into static files.
- [`web/`](web): the map.

Everything runs on free tiers: Cloudflare Workers, Durable Objects and D1, plus GitHub Actions.

## Running it locally

```bash
npm install
npm run bake     # downloads the timetable and map data into web/public/data (slow, a few minutes)
npm run dev      # the map, with live data proxied from bide.tgoyal.me
npm run deploy   # builds and deploys the site and the recorder to Cloudflare
```

## Data and thanks

Victoria sits on the traditional territories of the Lekwungen-speaking peoples, the Songhees and Esquimalt Nations.

Data sources:
- Transit: BC Transit open data.
- Map: © OpenStreetMap contributors, via Protomaps.
- Elevation: AWS Terrain Tiles.
- Weather, wind, sea state and air quality: Open-Meteo.
- Warnings and the Air Quality Health Index: Environment and Climate Change Canada.
- Tides: Fisheries and Oceans Canada.
- Earthquakes: USGS.
- Road works: DriveBC.
- Outages: BC Hydro.
- News: the RSS feeds of CHEK, the Times Colonist, Victoria News and Victoria Buzz.
