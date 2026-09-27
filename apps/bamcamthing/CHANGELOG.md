# bamcamthing

## 0.1.0

Bambuddy camera on the Car Thing screen.

Live MJPEG from `/api/v1/printers/{id}/camera/stream` with the print state from
`/api/v1/printers/{id}/overlay-status`: part name, progress, layer, time left,
nozzle and bed. The feed is a plain `<img>`, which only works because the app
asks for `net.proxy` so the device can route to Bambuddy; with the phone's
`net.fetch` tunnel as the fallback it polls snapshots instead.

Rotary cycles print, detail, and a clean feed. Preset 1 toggles the chrome,
2 the diagnostics line, 3 refetches, 4 the requested fps.
