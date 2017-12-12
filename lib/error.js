'use strict';
const Raven = require('raven');
Raven.config(process.env.RAVEN_CONFIG, {
    captureUnhandledRejections: true
}).install();

function replaceErrors(key, value) {
    if (value instanceof Error) {
        let error = {};

        Object.getOwnPropertyNames(value).forEach(function (key) {
            if (key === 'message') {
                let val = value[key];
                if (typeof val === 'string' || val instanceof String) {
                    val = val.split('\n').map(_ => _.replace('\r', ''))
                }
                error[key] = val;
            }
        });

        return error;
    }

    return value;
}

module.exports = (tgbot, channel) => {
    console.error = function (message) {
        if (!!message) {
            Raven.captureException(message);
            if (tgbot) {
                tgbot.sendMessage(channel, JSON.stringify(message, replaceErrors, 2)).catch((err) => {
                    console.log(err)
                });
            }
        }
        this.apply(console, arguments);
    }.bind(console.error);
};
