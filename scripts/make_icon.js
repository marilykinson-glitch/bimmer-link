'use strict';
/**
 * make_icon.js - tile icon for MyBMW & 1CR (apps/bimmer_link/icon.png, 140x140):
 * sleek connected car silhouette + remote-start radio waves + amber 1CR power ring.
 */
const fs = require('fs');
const path = require('path');
const { Canvas } = require(path.join(__dirname, '..', 'kit', 'runtime', 'canvas'));

const W = '#ffffff', A = '#2fd27a', B = '#4da6ff';
const c = new Canvas(140, 140);

// Wireless remote waves above the car
c.arc(70, 52, 22, 28, -50, 50, B);
c.arc(70, 52, 34, 40, -56, 56, W);

// Power / 1CR start emblem on the right
c.arc(106, 38, 12, 17, 35, 325, A);
c.line(106, 17, 106, 33, 5, A);

// Sleek car silhouette
c.strokeRoundRect(20, 74, 100, 32, 12, 6, W);
c.line(34, 74, 48, 56, 6, W);
c.line(48, 56, 90, 56, 6, W);
c.line(90, 56, 106, 74, 6, W);
// Wheels
c.circle(42, 108, 11, W);
c.circle(42, 108, 5, '#000000');
c.circle(98, 108, 11, W);
c.circle(98, 108, 5, '#000000');
// Headlight accent
c.line(26, 88, 36, 88, 5, B);
c.line(104, 88, 114, 88, 5, A);

const out = path.join(__dirname, '..', 'apps', 'bimmer_link', 'icon.png');
fs.writeFileSync(out, c.png());
console.log('wrote ' + out);
