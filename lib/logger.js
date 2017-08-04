'use strict';
const dateFormat = require('dateformat');

module.exports = (msg) => {
    let date = dateFormat(new Date(), 'yy-mm-dd HH:MM:ss');
    console.log(`[${date}] ${msg}`)
};