const socketHandler = (socket, io) => {
    console.log("A user connected");

    //listen for "message" event from clients
    socket.on("message", (data) => {
        console.log(`${data.username} sent a message: ${data.messageContent}`);
        //broadcast message to all clients
        io.emit("message", data);
    });

    //listen for disconnection
    socket.on("disconnect", () => {
        console.log("User disconnected: " + socket.id);
    });
};

module.exports = {
    socketHandler
};