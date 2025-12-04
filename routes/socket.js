// Store the raw token globally (you might want a better approach)
let cachedRawToken = null;

// Store the current classroom state
let currentClassroom = null;

// Store reference to formbar socket
let formbarSocketRef = null;


function setRawToken(token) {
    cachedRawToken = token;
    console.log('🔑 Raw token cached for Formbar auth');
    console.log('Token length:', token ? token.length : 0);
    
    // If formbar socket is already connected, authenticate immediately
    if (formbarSocketRef && formbarSocketRef.connected) {
        console.log('🔄 Re-authenticating with Formbar using new token...');
        formbarSocketRef.emit('auth', { token: cachedRawToken });
        
        // Request current classroom state after auth
        setTimeout(() => {
            console.log('📡 Requesting current classroom state from Formbar...');
            formbarSocketRef.emit('getClassroom');
        }, 500);
    }
}

function setupFormbarSocket(io, formbarSocket) {
    // Store reference for later use
    formbarSocketRef = formbarSocket;
    
    formbarSocket.on('connect', () => {
        console.log('✅ Connected to Formbar socket');

        if (cachedRawToken) {
            console.log('🔑 Sending auth token to Formbar...');
            formbarSocket.emit('auth', { token: cachedRawToken });
            
            // Request current classroom state after auth
            setTimeout(() => {
                console.log('📡 Requesting current classroom state from Formbar...');
                formbarSocket.emit('getClassroom');
            }, 500);
        } else {
            console.log('⚠️ No cached token available for Formbar auth');
        }
    });
    
    formbarSocket.on('classUpdate', (classroomData) => {
        console.log('Received classroom update from Formbar:', classroomData);
        
        // Store the current classroom state
        currentClassroom = classroomData;
        
        // Extract and broadcast auxiliary permission
        if (classroomData && classroomData.permissions && classroomData.permissions.auxiliary) {
            const auxiliaryPermission = parseInt(classroomData.permissions.auxiliary);
            console.log('=== AUXILIARY PERMISSION EXTRACTED ===');
            console.log('Raw value:', classroomData.permissions.auxiliary);
            console.log('Parsed value:', auxiliaryPermission);
            console.log('Broadcasting to all clients...');
            io.emit('auxiliaryPermission', auxiliaryPermission);
        } else {
            console.log('⚠️ No auxiliary permission found in classroom data');
        }
        
        // Relay the classroom data to all connected clients
        io.emit('classUpdate', classroomData);
    });

    formbarSocket.on('event', (data) => {
        console.log('Received event from Formbar:', data);
        io.emit('formbarEvent', data);
    });

    formbarSocket.on('connect_error', (err) => {
        console.error('❌ Formbar connection error:', err.message);
        console.error('Error details:', err);
    });

    formbarSocket.on('disconnect', (reason) => {
        console.log('⚠️ Disconnected from Formbar. Reason:', reason);
    });

    formbarSocket.on('reconnect_attempt', (attemptNumber) => {
        console.log(`🔄 Attempting to reconnect to Formbar (attempt ${attemptNumber})...`);
    });

    formbarSocket.on('reconnect', (attemptNumber) => {
        console.log(`✅ Reconnected to Formbar after ${attemptNumber} attempts`);
    });

    formbarSocket.on('reconnect_error', (err) => {
        console.error('❌ Reconnection error:', err.message);
    });

    formbarSocket.on('reconnect_failed', () => {
        console.error('❌ Failed to reconnect to Formbar after all attempts');
    });
}

function checkPermissions(io, formbarSocket) {

}

// Function to get current classroom data
function getCurrentClassroom() {
    return currentClassroom;
}

module.exports = { setupFormbarSocket, setRawToken, getCurrentClassroom };