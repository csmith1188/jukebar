# Jukebar
Jukebar is a Formbar.js plugin/app intended to allow users to play audio. It allows users to request audio using three different methods: from a pre-installed Soundboard (designed to look like a Jukebox), by extracting audio from a Youtube URL, and playing entire songs via Spotify API. Jukebar utilizes JavaScript and node.js. It is optimized for Google Chrome, but works in all modern browsers.

## Goals
- Consistent, seemless implementation with Formbar's features:
  - OAuth (login with Formbar account)
  - User permissions
  - Digipogs
  - Aesthetics
- Allows users to request audio with each of these three methods:
  - Sounboard
  - Youtube URL
  - Spotify API
- Sends user audio requests to Formbar
- Formbar plays audio over connected speakers

## Dependencies

Use the Node Package Manager (npm) to install the following external libraries to your node.js application:
- dotenv
- ejs
- express
- express-session
- fluent-ffmpeg API
- jsonwebtoken
- spotify-web-api-node
- sqlite3
- ytdl-core

***

## Acknowledgements
- Mr. Smith (csmith1181) - Instructor
- The Formbar team and its contributers

### 2024-25
- Isaiah Knaby (Isaia26633) - Project Lead, API Specialist
- Kris Bowman (kris26658) - Frontend Developer
- Connor Yeager (Conno26678) - Backend Developer
