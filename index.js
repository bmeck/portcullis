var net = require('net');
var dgram = require('dgram');
var MAX_PORT = 65535;

function callback(cb, err, value) {
  if (cb) process.nextTick(function () {
    cb(err, value);
  });
}

exports.Reservation = Reservation;
function Reservation(service, protocol, port) {
  this.service = service;
  this.protocol = protocol;
  this.port = +port;
  return this;
}

exports.parseLine = function (line, cb) {
  var parts = /^([0-9a-zA-Z_\-]+)(?:[/](tcp|udp))?\s*(\d+)$/g.exec(String(line));
  if (!parts) {
    return null;
  }
  var service = parts[1];
  var protocol = parts[2];
  var port = parts[3];
  return new Reservation(service, protocol, port);
}

exports.Jar = Jar;
function Jar(min, max) {
  this.services = Object.create(null);
  this.minPort = min == null ? 1025 : +min;
  this.maxPort = max == null ? MAX_PORT : +max;

  this._occupied = Object.create(null);
  this._base_port = this.minPort;
  return this;
}
Jar.prototype.findUnusedPort = function (protocol, preferred, attempts, cb) {
  var current_port = preferred ? +preferred : this._base_port;
  var first_port = current_port;
  if (current_port != current_port) {
    callback(cb, new Error('preferred port must be a number'))
  }
  var togo = attempts ? +attempts : Infinity;
  togo--;
  while (this._occupied[current_port]) {
    this._base_port = current_port;
    if (togo <= 0) {
      callback(cb, new Error('unable to find port in specified number of attempts'));
      return;
    }
    current_port = (current_port + 1) % (this.maxPort + 1);
    if (current_port === 0) current_port = this.minPort;
    if (current_port === first_port) {
      callback(cb, new Error('wrapped around and found no ports'));
      return;
    }
    togo--;
  }
  callback(cb, null, current_port);
}
Jar.prototype.reservations = function (service, cb) {
  var spec = this.services[service];
  if (!spec) {
    callback(cb, new Error('no service with that name'));
  }
  else {
    callback(cb, null, spec);
  }
}
Jar.prototype._reserveLine = function (line, cb) {
  var jar = this;
  var reservation = exports.parseLine(line);
  if (!reservation) {
    callback(cb, new Error('invalid line'), null);
    return; 
  }
  else if (this._occupied[reservation.port]) {
    callback(cb, new Error('port is occupied'), null);
    return;
  }
  if (reservation.port === 0) {
    this.findUnusedPort(reservation.protocol, null, Infinity, function (err, port) {
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
    jar._occupied[reservation.port] = reservation.service;
    spec.push(reservation);
    callback(cb, null, reservation);
  }
}
Jar.prototype.reserve = function (str, cb) {
  var jar = this;
  var lines = String(str).split(/(\r)?\n/g);
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
  var reservation = exports.parseLine(line);
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
      ret += reservation.service + (reservation.protocol ? '/' + reservation.protocol : '') + ' ' + reservation.port + '\n';
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
  var reservation = exports.parseLine(line);
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
  s.listen(port || 0, function (err) {
    if (err) callback(cb, err);
    else cb(null, s.address().port, s);
  });
}

function grabUDP(port, cb) {
  var s = dgram.createSocket('udp4'); 
  s.bind(port || 0, function (err) {
    if (err) cb(err);
    else cb(null, s.address().port, s);
  });
}
