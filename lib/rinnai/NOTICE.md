# Third-party code notice

The files in this directory (`RinnaiTouchUdp.js`, `RinnaiTouchTcp.js`, `RinnaiTouchRepository.js`,
`StateService.js`, `RinnaiTouchService.js`) are adapted from
[homebridge-rinnai-touch-plugin](https://github.com/mantorok1/homebridge-rinnai-touch-plugin)
by David Matthews, pinned at commit `6d54126d5547e0e2ce71d6f7f7870a5c340e313c`.

Original license: MIT.

```
MIT License

Copyright (c) David Matthews

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`Logger.js` in this directory is new code written for this app, matching the `debug`/`info`/`warn`/
`error` interface the ported files expect.

The remaining files started as copies of the pinned commit and have since diverged, substantially in
places. Notable changes, so the diff against upstream is not mistaken for the original design:

- **`RinnaiTouchTcp.js`** — connect attempts are bounded by a deadline and by the socket's idle
  timeout, an unsettled connect is failed locally rather than reported upwards, unsolicited closes
  are distinguished from ones we asked for, and incoming data is reassembled into frames rather than
  read one-frame-per-chunk.
- **`RinnaiTouchRepository.js`** — a command the module never acknowledges now throws instead of
  returning as if it succeeded; staleness checks guard against an absent timestamp; status frames are
  parsed defensively; errors propagate rather than being logged at every layer.
- **`RinnaiTouchService.js`** — `State`/`FanState` are modelled as the one tri-state field they
  actually share; target temperatures are compared as encoded values; setters propagate errors; the
  controller list is rebuilt on each `init()`.
- **`StateService.js`** — unmodified.

These files keep upstream's formatting so they stay diffable against it, and `.eslintrc.json` turns
the layout rules off for them rather than ignoring them outright — everything that can catch a bug
stays on. Reformatting them to the app's style would be a ~2k line diff and would make comparing
against upstream impractical. New code belongs in `RinnaiConnection.ts`, which is linted normally.
