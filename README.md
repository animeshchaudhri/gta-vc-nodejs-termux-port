gta-vc-nodejs-termux-port
===================================

Port made by the DOS.Zone team: https://dos.zone/reVCDOS

Official implementation: GitHub https://github.com/Carter54git/revcdos

I ported this to Node.js and it works on Termux as well.

Packed archive example: https://filebin.net/iuvsynyiwulyf7ov/revcdos.bin

Quick Start
-----------

Prerequisites:
- Node.js (14+ recommended) and npm (or yarn)

Install and run:

```bash
# clone the repo (if you haven't already)
git clone https://github.com/your/repo.git
cd gta-vc-nodejs-termux-port

# install dependencies (if package.json lists any)
npm install

# start the packed build
npm start -- --packed revcdos.bin

# then open http://localhost:8000 (or the port your server prints)
```

If you want to get bin use this url `https://filebin.net/iuvsynyiwulyf7ov/revcdos.bin`.

Termux (Android) Notes
----------------------

Termux provides a working Node.js package and can run simple Node servers. Typical steps on Termux:

```bash
pkg update && pkg upgrade
pkg install git nodejs
git clone https://github.com/your/repo.git
cd gta-vc-nodejs-termux-port
npm install
npm start -- --packed revcdos.bin
```

.
Testing on Termux
-----------------

1. Start the server on Termux with `npm start -- --packed revcdos.bin`.
2. In a browser on the same Wi‑Fi network, visit `http://<termux-device-ip>:<port>`.
3. To find the Termux device IP, run `ip addr show` or `ifconfig` in Termux.

If you want, I can provide exact commands to run on your device and help interpret any errors.

Troubleshooting
---------------

- If `npm install` fails, paste the error and I'll help diagnose it.
- If the server starts but you can't connect, check firewall rules and whether the server is bound to `0.0.0.0`.


----

If you'd like, I can also:
- add a local-only packed start script,
- switch the default port in `server.js`, or
- trim the remaining game shell branding further.
