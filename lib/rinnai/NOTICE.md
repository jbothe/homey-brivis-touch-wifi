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

`RinnaiTouchTcp.js`, `RinnaiTouchRepository.js`, `StateService.js` and `RinnaiTouchService.js` are
otherwise unmodified from the pinned commit. `Logger.js` in this directory is new code written for
this app, matching the `debug`/`info`/`warn`/`error` interface the ported files expect.
