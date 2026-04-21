# glide-range

Interactive map that shows where a paraglider pilot can actually glide to, given their height, glide ratio, wind, and — crucially — the terrain in the way.

**Live:** https://james-willis.github.io/glide-range/

## Usage

1. Click the map to drop a launch pin (drag to reposition).
2. Enter your current altitude MSL (m or ft), glide ratio, trim airspeed, wind speed (km/h), and wind direction (° *from*, meteorological).
3. Press **Compute glide range**. The shaded polygon is the reachable area.

## How it works

For each of 180 bearings the tool casts a ray from the pin. For a ground bearing θ with wind vector **W** and airspeed *V*:

- Ground speed `G(θ) = w∥ + √(V² − w⊥²)` where `w∥` and `w⊥` are the wind components along and across the ground track. If `w⊥ ≥ V`, the pilot can't crab onto that track — the ray is blocked.
- Altitude loss per metre of ground travel: `V / (GR · G(θ))`.
- Walk the ray outward in 60 m steps; terminate when the pilot's altitude drops to terrain elevation.

The 360 endpoints form the polygon.

### Data sources

- Base map: [OpenTopoMap](https://opentopomap.org) (CC-BY-SA) — OSM + SRTM contours.
- Terrain elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) in terrarium format. ~30 m resolution globally.
- Map renderer: [MapLibre GL JS](https://maplibre.org/).

## Limitations

- Terrain resolution is ~30 m, fine for ridges and valleys but not for tree-level clearance.
- Trim airspeed is assumed constant. Real polars trade airspeed for sink rate, and accelerated flight improves penetration into wind at the cost of glide.
- No thermals, no lift bands, no lee rotor — pure dead-air geometry.
- Wind is uniform: no gradients, no terrain deflection, no valley channelling.

It's a useful sanity check ("can I make it back to the LZ from here?"), not a flight planner.

## Development

Pure static site — no build step. Serve the directory with anything:

```sh
python3 -m http.server 8000
# or
npx serve .
```

Then open http://localhost:8000/.

## License

MIT.
