# bpcounter

A local, dependency-free web app to track daily bonus-point (BP) tasks on GTA5RP. Runs on Python's standard library only; data is stored as plain JSON files under `data/`.

**Live:** [bp.karatel.win](https://bp.karatel.win/)

## Usage
```bash
python server.py 8770
```
Then open http://localhost:8770. On Windows you can just run `start.bat`.

The day resets at 07:00 Moscow time.

## Requirements
- Python 3 (no external packages)

## License
MIT
