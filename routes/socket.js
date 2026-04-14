let cachedRawToken = null;
let currentClassroom = null;
let currentClassId = null;
let formbarSocketRef = null;
let apiKey = '';
let classRetryTimer = null;

function setRawToken(token) {
    cachedRawToken = token;
}

function setupFormbarSocket(io, formbarSocket, key) {
    formbarSocketRef = formbarSocket;
    apiKey = key || '';

    formbarSocket.on('connect', () => {
        // console.log('[socket] Connected to Formbar');
        formbarSocket.emit('getActiveClass', apiKey);
    });

    formbarSocket.on('setClass', (userClassId) => {
        if (classRetryTimer) {
            clearTimeout(classRetryTimer);
            classRetryTimer = null;
        }

        if (userClassId == null) {
            // Formbar sends null when leaving old class - reconnect to pick up the new one
            classRetryTimer = setTimeout(() => {
                classRetryTimer = null;
                formbarSocket.disconnect();
                formbarSocket.connect();
            }, 0);
        } else {
            if (currentClassId !== userClassId) {
                console.log(`[socket] Class switched: ${userClassId} (was ${currentClassId})`);
            }
            formbarSocket.emit('classUpdate');
        }

        currentClassId = userClassId;
    });

    formbarSocket.on('classUpdate', (classroomData) => {
        currentClassroom = classroomData;

        const incomingId = classroomData?.id;
        if (incomingId != null) {
            if (currentClassId !== incomingId) {
                console.log(`[socket] Class updated: ${classroomData?.className} (id: ${incomingId}, was ${currentClassId})`);
            }
            currentClassId = incomingId;
        }

        if (classroomData?.permissions?.auxiliary) {
            io.emit('auxiliaryPermission', parseInt(classroomData.permissions.auxiliary));
        }

        io.emit('classUpdate', classroomData);
    });

    formbarSocket.on('event', (data) => {
        io.emit('formbarEvent', data);
    });

    formbarSocket.on('connect_error', (err) => {
        console.error('[socket] Formbar connection error:', err.message);
    });

    formbarSocket.on('disconnect', (reason) => {
        if (reason !== 'io client disconnect') {
            console.warn('[socket] Disconnected from Formbar:', reason);
        }
    });

    formbarSocket.on('reconnect_failed', () => {
        console.error('[socket] Failed to reconnect to Formbar');
    });

    // Poll Formbar every 30s to catch class switches
    setInterval(() => {
        if (formbarSocket.connected) {
            formbarSocket.emit('getActiveClass', apiKey);
        }
    }, 30000);
}

function getCurrentClassroom() {
    return currentClassroom;
}

function getCurrentClassId() {
    return currentClassId;
}

module.exports = { setupFormbarSocket, setRawToken, getCurrentClassroom, getCurrentClassId, requestAndWaitForClassId };

/**
 * Requests the active class ID from Formbar and waits for the response.
 * @param {number} timeoutMs
 * @returns {Promise<any>} the class ID, or null on timeout
 */
function requestAndWaitForClassId(timeoutMs = 3000) {
    return new Promise((resolve) => {
        if (currentClassId != null) return resolve(currentClassId);

        if (!formbarSocketRef || !formbarSocketRef.connected) {
            return resolve(null);
        }

        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            formbarSocketRef.off('setClass', onSetClass);
            formbarSocketRef.off('classUpdate', onClassUpdate);
            resolve(currentClassId);
        }, timeoutMs);

        function onSetClass(userClassId) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            formbarSocketRef.off('classUpdate', onClassUpdate);
            currentClassId = userClassId;
            resolve(currentClassId);
        }

        function onClassUpdate(classroomData) {
            if (settled) return;
            const id = classroomData?.id;
            if (id != null) {
                settled = true;
                clearTimeout(timer);
                formbarSocketRef.off('setClass', onSetClass);
                currentClassId = id;
                resolve(currentClassId);
            }
        }

        formbarSocketRef.on('setClass', onSetClass);
        formbarSocketRef.on('classUpdate', onClassUpdate);

        formbarSocketRef.emit('getActiveClass', apiKey);
    });
}