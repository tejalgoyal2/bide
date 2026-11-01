# bide

A living map of Victoria, BC: every bus moving right now, drawn on an illustrated city that rises out of an animated sea. Underneath it, a recorder keeps every bus position and every one of BC Transit's arrival predictions, so bide's own prediction model can be scored honestly against the official one.

**Live:** https://bide.itejalgoyal.workers.dev

## What's here

- **The map** (`web/`): three.js, no map library. Land, parks, lakes and streets are painted from OpenStreetMap; hills come from open elevation data; the sea's foam follows a distance field of the real coastline. Light follows the real sun and moon over Victoria. Weather (Open-Meteo) and tide (Fisheries and Oceans Canada) are live.
- **Live buses**: decoded from BC Transit's GTFS-Realtime feed, snapped onto their route shapes and dead-reckoned between reports so they glide rather than jump. Colour them by route, crowding (BC Transit reports how full each bus is) or lateness.
- **Activity columns**: scheduled departures per hour in hexagonal cells, following the time of day. Drag the dial or press play to watch a day.
- **The recorder** (`worker/`): a Cloudflare Worker and a SQLite Durable Object that polls the vehicle feed every 10 s, the trip-update predictions every minute and service alerts every 5 minutes, storing compact gzipped snapshots. It also serves the live feed to the map.
- **A tiny protobuf reader** (`shared/gtfsrt.js`): decodes GTFS-Realtime in about 3 ms, so the recorder fits in the free plan's 10 ms CPU budget.

## The scoreboard (in progress)

Beating the official predictions only means something if the comparison is fair: the same trips, the same stops, the same lead time, scored against the same observed arrivals. The recorder has been collecting since 31 October 2026; the first comparison needs about two weeks of history.

## Running it

```bash
npm install
npm run bake     # downloads the GTFS schedule (slow) and map data into web/public/data
npm run dev      # http://localhost:5173, live data proxied from the deployed Worker
npm run deploy   # builds and deploys the site and the recorder to Cloudflare
```

Everything runs on Cloudflare's free plan, where hitting a limit makes requests fail rather than cost money. The recorder also stops writing at 4 GB, well short of the free 5 GB.

## Data and thanks

Victoria sits on the traditional territories of the Lekwungen-speaking peoples, the Songhees and Esquimalt Nations.

Map data © OpenStreetMap contributors, via the Protomaps basemap. Elevation: AWS Terrain Tiles (Mapzen). Transit: BC Transit open data. Weather: Open-Meteo. Tides: Fisheries and Oceans Canada.
