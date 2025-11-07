# Filedrop

This project is a fork of the original [Snapdrop](https://github.com/RobinLinus/snapdrop). We are very grateful for the work of the original developers.

## Why Filedrop?

The original Snapdrop project was acquired by LimeWire. This has led to concerns within the community regarding user privacy and data collection on the official `snapdrop.net` domain. For more context, you can read the community discussions [here](https://github.com/SnapDrop/snapdrop/issues/663).

This fork, **Filedrop**, was created to provide a version of Snapdrop that is free from third-party acquisitions and potential data tracking. Our goal is to continue the original spirit of Snapdrop as a simple, private, and local file sharing solution. This repository is based on the original source code, with the aim of ensuring it remains clean and independent.

---
# Snapdrop

[Snapdrop](https://snapdrop.net): local file sharing in your browser. Inspired by Apple's Airdrop.

## Classic Snapdrop is built with the following awesome technologies
* Vanilla HTML5 / ES6 / CSS3 frontend
* [WebRTC](http://webrtc.org/) / [WebSockets](http://www.websocket.org/)
* [NodeJS](https://nodejs.org/en/) backend
* [Progressive Web App](https://wikipedia.org/wiki/Progressive_Web_App)


Have any questions? Read our [FAQ](/docs/faq.md).

You can [host your own instance with Docker](/docs/local-dev.md).

## Running with Deno

This project is now powered by [Deno](https://deno.land/).

To run the project locally, you need to have Deno installed. You can find the installation instructions [here](https://deno.land/manual/getting_started/installation).

Once you have Deno installed, you can start the server with the following command:

```bash
deno run --allow-net --allow-read deno.ts
```

- `--allow-net`: This permission is required to create a web server.
- `--allow-read`: This permission is required to serve the files from the `public` directory.

The server will start on `http://localhost:8000`.
