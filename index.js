var util = require('util');
var EventEmitter = require('events').EventEmitter;
var net = require('net');
var dgram = require('dgram');
var MAX_PORT = 65535;

function callback(cb, err, value) {
  if (cb) process.nextTick(function () {
    cb(err, value);
  });
}

function sluggify_service_name(str) {
  return str.replace(/[^a-zA-Z0-9\-]|[_]/g, '_$&');
}

exports.Reservation = Reservation;
function Reservation(service, protocol, port) {
  this.service = service;
  this.protocol = protocol;
  this.port = +port;
  return this;
}
Reservation.stringify = function (reservation) {
  return reservation.service + (reservation.protocol ? '/' + reservation.protocol : '') + ' ' + reservation.port;
}
Reservation.parse = function (line) {
  var parts = /^(.*?)(?:[/](tcp|udp))?\s*(\d+)$/g.exec(String(line));
  if (!parts) {
    return null;
  }
  var service = sluggify_service_name(parts[1]);
  var protocol = parts[2];
  var port = parts[3];
  return new Reservation(service, protocol, port);
}

exports.Jar = Jar;
function Jar(min, max) {
  EventEmitter.call(this);
  this.services = Object.create(null);
  this.minPort = min == null ? 1025 : +min;
  this.maxPort = max == null ? MAX_PORT : +max;

  this._occupied = Object.create(null);
  this._base_port = this.minPort;
  return this;
}
util.inherits(Jar, EventEmitter);
Jar.prototype._findUnusedPort = function (protocol, preferred, attempts, value, cb) {
  var jar = this;
  var current_port = preferred ? +preferred : this._base_port;
  var first_port = current_port;
  if (current_port != current_port) {
    cb(new Error('preferred port must be a number'))
  }
  var togo = attempts ? +attempts : Infinity;

  var attempt = function attempt() {
    togo--;
    while (jar._occupied[current_port]) {
      jar._base_port = current_port;
      if (togo <= 0) {
        cb(new Error('unable to find port in specified number of attempts'));
        return;
      }
      current_port = (current_port + 1) % (jar.maxPort + 1);
      if (current_port === 0) current_port = jar.minPort;
      if (current_port === first_port) {
        cb(new Error('wrapped around and found no ports'));
        return;
      }
      togo--;
    }
  
    jar._occupied[current_port] = value;
    grabTCP(current_port, function (err, port, server) {
      // leave it occupied
      if (err) {
        attempt();
        return;
      }
      server.close(function () {
        jar.emit('updated');
        cb(null, port);
      });
    });
  }
  attempt();
}
Jar.prototype.reservations = function (service, cb) {
  var spec = this.services[sluggify_service_name(service)];
  if (!spec) {
    callback(cb, new Error('no service with that name'));
  }
  else {
    callback(cb, null, spec);
  }
}
Jar.prototype._reserveLine = function (line, cb) {
  var jar = this;
  var reservation;
  if (line instanceof Reservation) {
     reservation = line;
  }
  else {
     line = String(line).trim();
     if (line === '') {
       callback(cb, null, null);
       return;
     }
     reservation = Reservation.parse(line);
  }
  if (!reservation) {
    callback(cb, new Error('invalid line'), null);
    return; 
  }
  else if (this._occupied[reservation.port]) {
    callback(cb, new Error('port is occupied'), null);
    return;
  }
  if (reservation.port === 0) {
    this._findUnusedPort(reservation.protocol, null, Infinity, reservation.service, function (err, port) {
      if (err) callback(cb, err);
      else {
        reservation.port = port;
        register_port();
      }
    });
  }
  else {
    register_port();
  }
  function register_port() {
    var spec = jar.services[reservation.service];
    if (!spec) spec = jar.services[reservation.service] = [];
    spec.push(reservation);
    callback(cb, null, reservation);
  }
}
Jar.prototype.reserve = function (str, cb) {
  var jar = this;
  var lines = Array.isArray(str) ? str : String(str).split(/(\r)?\n/g);
  var reservations = [];
  // we use pop off due to port 0 getting confusing
  var done = false;
  function next(err, reservation) {
    if (done) return;
    if (reservation) reservations.push(reservation);
    if (err) {
      done = true;
      callback(cb, err, null);
    }
    else if (!lines.length) {
      done = true;
      callback(cb, null, reservations)
    }
    else {
      var line = lines.shift();
      jar._reserveLine(line, next);
    }
  }
  next(null, null);
}
Jar.prototype.drop = function (line, cb) {
  var reservation = Reservation.parse(line);
  var service = reservation.service;
  var port = reservation.service;
  var protocol = reservation.protocol;
  if (!reservation) callback(cb, new Error('invalid line'));
  var spec = this.services[service];
  for (var i = 0; i < spec.length; i++) {
    if (spec[i].service === service
    && spec[i].port === port
    && spec[i].protocol === protocol) {
      spec.splice(i, 1);
      delete this._occupied[port];
      if (spec.length === 0) delete spec[service];
      this.emit('updated');
      break;
    }
  }
  callback(cb, null);
}
Jar.stringify = function (jar) {
  var ret = '';
  Object.keys(jar.services).forEach(function (service) {
    var spec = jar.services[service]; 
    spec.forEach(function (reservation) {
      ret += Reservation.stringify(reservation) + '\n';
    });
  });
  return ret;
}
Jar.parse = function (str) {
  var jar = new Jar();
  jar.reserve(str);
  return jar;
}

exports.allocateFromLine = function (line, cb) {
  var reservation = Reservation.parse(line);
  if (!reservation) callback(cb, new Error('invalid line'));
  else exports.allocate(reservation, cb);
}

function AllocateResult(reservation, tcp_server, udp_server) {
  this.reservation = reservation;
  this.tcp_server = tcp_server || null;
  this.udp_server = udp_server || null;
  return this;
}

exports.allocate = function (reservation, cb) {
  var service = reservation.service;
  var protocol = reservation.protocol;
  var port = reservation.port;
  if (protocol) {
    if (protocol === 'tcp') {
      grabTCP(port, function (err, port, tcp_socket) {
        callback(cb, err, new AllocateResult(new Reservation(service, protocol, port), tcp_socket, null)); 
      });
    }
    else if (protocol === 'udp') {
      grabUDP(port, function (err, port, udp_socket) {
        callback(cb, err, new AllocateResult(new Reservation(service, protocol, port), null, udp_socket));
      });
    }
    else {
      callback(cb, new Error('invalid protocol ' + protocol));
    }
  }
  else {
    grabTCP(port, function (err, tcp_port, tcp_socket) {
      if (err) callback(cb, err);
      else {
        grabUDP(tcp_port, function (err, udp_port, udp_socket) {
          if (err) {
            callback(cb, new Error('unable to allocate matching port'));
          }
          else {
            callback(cb, err, new AllocateResult(new Reservation(service, protocol, tcp_port), tcp_socket, udp_socket));
          }
        });
      }
    });
  }
}

function grabTCP(port, cb) {
  var s = net.createServer();
  s.on('error', cb);
  s.listen(port || 0, function (err) {
    if (err) callback(cb, err);
    else cb(null, s.address().port, s);
  });
}

function grabUDP(port, cb) {
  var s = dgram.createSocket('udp4'); 
  s.on('error', cb);
  s.bind(port || 0, function (err) {
    if (err) cb(err);
    else cb(null, s.address().port, s);
  });
}
