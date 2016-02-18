module.exports = RedisStore;

var debug = require('debug')('RedisStore');
var randomstring = require("randomstring");
var util = require('./util.js');

var apn = require('apn');

var apnConnection;

var pathToServer = {};

String.prototype.hashCode = function () {
    var hash = 0;
    if (this.length == 0) return hash;
    for (i = 0; i < this.length; i++) {
        char = this.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
}


function RedisStore(config, redis, subClient) {
    if (!(this instanceof RedisStore)) return new RedisStore(config, redis, subClient);
    this.redis = redis;
    subClient.on("message", function (channel, message) {
        //debug("subscribe message " + channel + ": " + message);
        if (channel === "packetServer") {
            var handlerInfo = JSON.parse(message);
            updatePathServer(handlerInfo);
        }
    });
    subClient.subscribe("packetServer");
    config.apn.maxConnections = 10;
    config.apn.errorCallback = function (errorCode, notification, device) {
        var id = device.token.toString('hex');
        debug("apn errorCallback %d %s", errorCode, id);
        if (errorCode == 8) {
            redis.hdel("apnTokens", id);
        }
    }
    apnConnection = new apn.Connection(config.apn);

}

function updatePathServer(handlerInfo) {
    var timestamp = new Date().getTime();
    var serverId = handlerInfo.serverId;
    for (path of handlerInfo.paths) {
        var servers = pathToServer[path];
        if (!servers) {
            servers = [];
        }
        var updatedServers = [];
        var found = false;
        for (server of servers) {
            if (server.serverId === serverId) {
                server.timestamp = timestamp;
                updatedServers.push(server);
                found = true;
            } else if (timestamp - server.timestamp > 10000) {
                debug("server is dead %s", server.serverId);
            } else {
                updatedServers.push(server);
            }
        }
        if (!found) {
            debug("new server is added %s", serverId);
            updatedServers.push({serverId: serverId, timestamp: timestamp});
        }
        pathToServer[path] = updatedServers;
    }
}

function hashIndex(pushId, count) {
    return pushId.hashCode() % count;
}

RedisStore.prototype.publishPacket = function (data) {
    var path = data.path;
    var pushId = data.pushId;
    if (path && pushId) {
        if (!data.sequenceId) {
            data.sequenceId = randomstring.generate(16);
        }
        var servers = pathToServer[path];
        var strData = JSON.stringify(data);
        if (servers) {
            var serverCount = servers.length;
            var idx = hashIndex(pushId, serverCount);
            if (servers[idx]) {
                var serverId = servers[idx]["serverId"];
                this.redis.publish("packetProxy#" + serverId, strData);
                debug("publishPacket %s %s", serverId, strData);
                return;
            }
        }
        this.redis.publish("packetProxy#default", strData);
    }
};

RedisStore.prototype.publishDisconnect = function (socket) {
    debug("publishDisconnect pushId %s", socket.pushId);
    var outerThis = this;
    this.redis.get("pushIdSocketId#" + socket.pushId, function (err, lastSocketId) {
        // reply is null when the key is missing
        debug("pushIdSocketId redis %s %s", lastSocketId, socket.pushId);
        if (lastSocketId === socket.id) {
            debug("publishDisconnect current socket disconnect %s", socket.id);
            outerThis.redis.del("pushIdSocketId#" + socket.pushId);
            var data = {pushId: socket.pushId, path: "/socketDisconnect"};
            if (socket.uid) {
                data.uid = socket.uid;
            }
            outerThis.publishPacket(data);
        }
    });
};

RedisStore.prototype.publishConnect = function (socket) {
    debug("publishConnect pushId %s", socket.pushId);
    var outerThis = this;
    this.redis.get("pushIdSocketId#" + socket.pushId, function (err, lastSocketId) {
        // reply is null when the key is missing
        debug("publishConnect query redis %s", lastSocketId);
        if (lastSocketId) {
            debug("reconnect do not publish", lastSocketId);
        } else {
            debug("first connect publish", lastSocketId);
            var data = {pushId: socket.pushId, path: "/socketConnect"};
            if (socket.uid) {
                data.uid = socket.uid;
            }
            outerThis.publishPacket(data);
        }
        outerThis.redis.set("pushIdSocketId#" + socket.pushId, socket.id);
        outerThis.redis.expire("pushIdSocketId#" + socket.pushId, 3600 * 24 * 7);
    });
};

RedisStore.prototype.setApnToken = function (pushId, apnToken) {
    if (pushId && apnToken) {
        var outerThis = this;
        this.redis.get("apnTokenToPushId#" + apnToken, function (err, oldPushId) {
            if (oldPushId) {
                debug("removing duplicate pushIdToApnToken %s", oldPushId);
                outerThis.redis.del("pushIdToApnToken#" + oldPushId);
            }
            outerThis.redis.set("pushIdToApnToken#" + pushId, apnToken);
            outerThis.redis.expire("pushIdToApnToken#" + pushId, 3600 * 24 * 7);
            outerThis.redis.set("apnTokenToPushId#" + apnToken, pushId);
            outerThis.redis.expire("apnTokenToPushId#" + pushId, 3600 * 24 * 7);
            outerThis.redis.hset("apnTokens", apnToken, 1);
            debug("set pushIdToApnToken %s %s", pushId, apnToken);
        });
    }
};

RedisStore.prototype.sendNotification = function (pushIds, notification, io) {
    pushIds.forEach(function (pushId) {
        io.to(pushId).emit('noti', notification);
    });

    util.batch(this.redis, "get", "pushIdToApnToken#", pushIds, function (replies) {
        debug("util.batchGet %s", replies);
        replies.clean();
        if (replies.length > 0) {
            var note = toApnNotification(notification);
            apnConnection.pushNotification(note, replies);
        }
    });
};

Array.prototype.clean = function () {
    for (var i = 0; i < this.length; i++) {
        if (!this[i]) {
            this.splice(i, 1);
            i--;
        }
    }
    return this;
};

RedisStore.prototype.sendNotificationToAll = function (notification, io) {
    io.to("noti").emit('noti', notification);
    this.redis.hkeys("apnTokens", function (err, replies) {
        debug(replies.length + " replies:");
        var note = toApnNotification(notification);
        if (replies.length > 0) {
            apnConnection.pushNotification(note, replies);
        }
    });
};

function toApnNotification(notification) {
    var note = new apn.Notification();
    note.badge = notification.apn.badge;
    if (notification.apn.sound) {
        note.sound = notification.apn.sound;
    } else {
        note.sound = "default";
    }
    note.alert = notification.apn.alert;
    note.expiry = Math.floor(Date.now() / 1000) + 600;
    if (notification.apn.payload) {
        note.payload = notification.apn.payload;
    } else {
        note.payload = {};
    }
    return note;
}


