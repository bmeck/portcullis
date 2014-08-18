var net = require('net');
var dgram = require('dgram');

exports.findFromLine = function (line, cb) {
  var parts = /^[0-9a-zA-Z_\-]+(?:[/](tcp|udp))?\s*\d+i$/.exec(String(line));
  if (!parts) {
    cb(new Error('invalid line'));
    return;
  }
  var service = parts[0];
  var protocol = parts[1];
  var port = parts[2];
  exports.find(service, protocol, port, cb);
}

function FindResult(service, protocol, port, tcp_server, udp_server) {
  this.service = service;
  this.protocol = protocol;
  this.port = +port;
  this.tcp_server = tcp_server || null;
  this.udp_server = udp_server || null;
  return this;
}

exports.find = function (service, protocol, port, cb) {
  if (protocol) {
    if (protocol === 'tcp') {
      grabTCP(port, function (err, port, tcp_socket) {
        cb(err, new FindResult(service, protocol, port, tcp_socket, null)); 
      });
    }
    else if (protocol === 'udp') {
      grabUDP(port, function (err, port, udp_socket) {
        cb(err, new FindResult(service, protocol, port, null, udp_socket));
      });
    }
    else {
      cb(new Error('invalid protocol ' + protocol));
    }
  }
  else {
    grabTCP(port, function (err, tcp_port, tcp_server) {
      if (err) cb(err)
      else {
        grabUDP(tcp_port, function (err, udp_port, udp_server) {
          if (err) {
            cb(new Error('unable to allocate matching port'));
          }
          else {
            cb(err, new FindResult(service, protocol, port, tcp, udp_socket));
          }
        });
      }
    });
  }
}

function grabTCP(port, cb) {
  var s = net.createServer();
  s.listen(port || 0, function (err) {
    if (err) cb(err);
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
