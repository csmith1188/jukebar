# Spotify Developer Dashboard Setup Tutorial

A step-by-step guide to creating a Spotify app, retrieving your **Client ID**, and generating your **Client Secret**.

---

## Prerequisites

- A Spotify Premium account 
- A web browser

---

## Step 1: Log In to the Spotify Developer Dashboard

1. Go to [https://developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Click **Log in** in the top-right corner.
3. Enter your Spotify credentials and authorize access when prompted.

> **Note:** If this is your first time, you may be asked to agree to Spotify's Developer Terms of Service. Read and accept them to proceed.

---

## Step 2: Create a New App

1. Once logged in, you'll land on the **Dashboard** home page.
2. Click the **Create app** button (top-right area of the page).
3. Fill in the app creation form:

   | Field | Description |
   |---|---|
   | **App name** | A unique name for your app (e.g., `Jukebar`) |
   | **App description** | A brief description of what your app does |
   | **Redirect URI** | The URL Spotify will redirect to after authentication (e.g., `http://127.0.0.1:3000/callback` for local development) |
   | **Which API/SDKs are you planning to use?** | Select the Web API |
    An example of what it should look like can be seen here: ![Example](example.png)
4. Check the box to agree to the **Spotify Developer Policy** and **Design Guidelines**.
5. Click **Save**.

> **Note:** As of April 2025 Spotify updated the API to no longer accept localhost as a redirect URI.

---

## Step 3: Access Your App Settings

After saving, you'll be taken to your **app overview page**. From here:

Your client ID should be visible under **Basic Information** as well as a `View client secret` hyperlink that reveals the client secret 

---

## Step 4: Get Your Client ID


- It looks like a 32-character alphanumeric string, e.g.:  
  `a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6`

- **Copy it** and store it somewhere safe — you'll use this in your app's environment variables or config file.

---

## Step 5: Get Your Client Secret

Your Client Secret is hidden by default for security.

1. On the same **Basic Information** page, find the **Client Secret** field.
2. Click **View client secret**.
4. Once revealed, **copy the secret immediately** and store it securely.

> ⚠️ **Security Warning:** Treat your Client Secret like a password. Never expose it in:
> - Public GitHub repositories
> - Client-side JavaScript
> - Any frontend code
>
> Use environment variables (`.env` files) to keep it out of your codebase.

---

## Step 6: Edit Redirect URIs

The redirect URI will only be needed to grab your spotify refresh token, after running the script for getting the refresh token you may delete your redirect URI as you will not need it again unless your account changes

---

## Step 7: Get Your Refresh Token

With your Client ID, Client Secret, and Redirect URI in hand, you can now run the provided `spotify.js` script to obtain a **refresh token**.

### Setup

1. Open `spotify.js` and fill in your credentials at the top of the file:

```js
const CLIENT_ID     = "your_client_id_here";
const CLIENT_SECRET = "your_client_secret_here";
const REDIRECT_URI  = "http://127.0.0.1:5000/callback";
```

> **Note:** Make sure `http://127.0.0.1:5000/callback` is added as a Redirect URI in your Spotify app settings (see Step 6).

### Run the Script

2. In your terminal, run:

```bash
node spotify.js
```

3. The script will print a Spotify authorization URL in the terminal. Copy it and open it in your browser.

4. Log in with your Spotify account and click **Agree** to grant the requested permissions.

5. Spotify will redirect your browser to `http://127.0.0.1:5000/callback`. The script will automatically exchange the code for tokens and print them to your terminal:

```
REFRESH TOKEN:
BQD...your_refresh_token...

ACCESS TOKEN:
BQC...your_access_token...
```

6. **Copy the refresh token** — this is what you'll store in your `.env` file. You only need to run this script once unless your credentials change.

---

## Step 8: Using Your Credentials

Store your credentials securely in a `.env` file:

```env
SPOTIFY_CLIENT_ID=your_client_id_here
SPOTIFY_CLIENT_SECRET=your_client_secret_here
SPOTIFY_REFRESH_TOKEN=your_token_here
```

Then load them in your app. Example in Node.js:

```js
require('dotenv').config();

const clientId     = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
const refreshToken  = process.env.SPOTIFY_REFRESH_TOKEN;
```

---

## Step 8: Managing Users (Development Mode)

By default, new apps are in **Development Mode**, which limits access to **10 users**. Those 10 users must be added.

To add users in Development Mode:

1. Go to your app's **Settings** page.
2. Scroll to **User Management**.
3. Enter the Spotify email address of the user and click **Add user**.
4. Input the users full name, and email address.

To remove the 10-user limit, you need to apply for an **Extended Quota** through the dashboard.

---

## Quick Reference

| Item | Where to Find It |
|---|---|
| Client ID | App → Settings → Basic Information |
| Client Secret | App → Settings → Client Secret → "View client secret" |
| Redirect URI | App → Settings → Redirect URIs |
| User Management | App → Settings → User Management |
| Refresh token | Run the `Spotify.js` script|

---

## Useful Links

- [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
- [Spotify Web API Documentation](https://developer.spotify.com/documentation/web-api)
- [Authorization Guide](https://developer.spotify.com/documentation/web-api/concepts/authorization)
- [Spotify Developer Policy](https://developer.spotify.com/policy)
