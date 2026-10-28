const SPOTIFY_CLIENT_ID = "";
const SPOTIFY_CLIENT_SECRET = "";
const SPOTIFY_SCOPES =
  "user-read-private user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public";
const SPOTIFY_REDIRECT_URI = "http://127.0.0.1:8888/callback";

const http = require("http");

const authUrl =
  "https://accounts.spotify.com/authorize?" +
  new URLSearchParams({
    response_type: "code",
    client_id: SPOTIFY_CLIENT_ID,
    scope: SPOTIFY_SCOPES,
    redirect_uri: SPOTIFY_REDIRECT_URI,
  });

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url, SPOTIFY_REDIRECT_URI).searchParams.get("code");
  if (!code) return res.end();

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
    }),
  });

  const data = await tokenRes.json();
  console.log(data.refresh_token ? "\nRefresh token: " + data.refresh_token : data);
  res.end("Done, you can close this tab.");
  server.close();
});

server.listen(8888, () => console.log("Open this URL:\n\n" + authUrl + "\n"));
