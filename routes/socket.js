// Store the raw token globally (you might want a better approach)
let cachedRawToken = null;

// Store the current classroom state
let currentClassroom = null;


function setRawToken(token) {
    cachedRawToken = token;
}

function setupFormbarSocket(io, formbarSocket) {
    formbarSocket.on('connect', () => {
        console.log('Connected to Formbar socket');

        if (cachedRawToken) {
            formbarSocket.emit('auth', { token: cachedRawToken });
        }
    });
    
    formbarSocket.on('classUpdate', (classroomData) => {
        console.log('Received classroom update from Formbar:', classroomData);
        
        // Store the current classroom state
        currentClassroom = classroomData;
        
        // Relay the classroom data to all connected clients
        io.emit('classUpdate', classroomData);
    });

    formbarSocket.on('event', (data) => {
        console.log('Received event from Formbar:', data);
        io.emit('formbarEvent', data);
    });

    formbarSocket.on('connect_error', (err) => {
        console.error('Formbar connection error:', err);
    });
}

function checkPermissions(io, formbarSocket) {

}

// Function to get current classroom data
function getCurrentClassroom() {
    return currentClassroom;
}

module.exports = { setupFormbarSocket, setRawToken, getCurrentClassroom };