# Jukebar - Modular Structure

## 📁 Project Structure

```
Jukebar/
├── app.js                 # Main application entry point (streamlined)
├── app-backup.js          # Original monolithic app.js (backup)
├── package.json
├── .env
│
├── routes/                # Route handlers
│   ├── auth.js           # Authentication routes (login, logout, checkPerms)
│   ├── spotify.js        # Spotify API routes (search, queue, skip, etc.)
│   └── payment.js        # Payment routes (transfer, refund, PIN management)
│
├── middleware/            # Express middleware
│   └── auth.js           # isAuthenticated middleware
│
├── utils/                 # Utility modules
│   ├── spotify.js        # Spotify API configuration and helpers
│   └── database.js       # SQLite database connection
│
├── views/                 # EJS templates
│   ├── player.ejs
│   └── partials/
│       └── pay.ejs
│
├── public/                # Static files
│   ├── styles.css
│   └── img/
│
└── db/
    └── database.db
```

## 🔧 Module Breakdown

### **app.js** (Main Entry Point)
- Express server setup
- Session configuration
- Route registration
- Socket.IO setup
- **Lines of code: ~80** (was 636!)

### **routes/auth.js**
- `/login` - OAuth callback handler
- `/logout` - Session destruction
- `/checkPerms` - Permission checking

### **routes/spotify.js**
- `/search` - Search Spotify tracks
- `/getQueue` - Get current queue
- `/addToQueue` - Add track to queue
- `/currentlyPlaying` - Get currently playing track
- `/skip` - Skip current track

### **routes/payment.js**
- `/transfer` - Handle payment to system
- `/refund` - Process refunds
- `/claimPayment` - Claim payment for action
- `/savePin` - Save user PIN
- `/getPin` - Retrieve user PIN
- `/paymentStatus` - Check payment status

### **middleware/auth.js**
- `isAuthenticated` - Protect routes requiring login

### **utils/spotify.js**
- Spotify API configuration
- `ensureSpotifyAccessToken()` - Token refresh helper

### **utils/database.js**
- SQLite database connection

## 🚀 Benefits

✅ **Maintainability** - Easy to find and update specific features  
✅ **Readability** - Each file has a single responsibility  
✅ **Scalability** - Easy to add new routes or features  
✅ **Testing** - Modules can be tested independently  
✅ **Collaboration** - Multiple developers can work on different modules  

## 📝 Running the Application

```bash
# Install dependencies
npm install

# Start the server
node app.js
```

## 🔄 Reverting to Old Structure

If you need to revert to the original monolithic structure:

```bash
# Windows PowerShell
Copy-Item "app-backup.js" "app.js" -Force

# Or use the backup file directly
node app-backup.js
```

## 🛠️ Adding New Features

### Adding a new route:

1. Create a new file in `routes/` (e.g., `routes/admin.js`)
2. Define your routes using `express.Router()`
3. Import and use in `app.js`:
   ```javascript
   const adminRoutes = require('./routes/admin');
   app.use('/', adminRoutes);
   ```

### Adding new utility functions:

1. Create a new file in `utils/` (e.g., `utils/helpers.js`)
2. Export your functions
3. Import where needed:
   ```javascript
   const { myHelper } = require('../utils/helpers');
   ```
