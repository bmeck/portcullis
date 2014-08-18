# Portcullis

A utility for managing port reservations ala portreserve.

```javascript
var pc = require('portcullis');
var jar = pc.Jar.parse(['ssh 22', 'smtp/tcp 25'].join('\n'));
jar.reserve('http 0', function () {
  jar.reservations("sshd", console.log);
});
```

```javascript
pc.Jar.stringify(jar) // outputs in portreserve file format
```
