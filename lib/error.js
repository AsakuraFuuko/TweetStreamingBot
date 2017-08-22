'use strict';

function replaceErrors(key, value) {
    if (value instanceof Error) {
        let error = {};

        Object.getOwnPropertyNames(value).forEach(function (key) {
            if (key === 'stack' || key === 'message') {
                error[key] = value[key];
            }
        });

        return error;
    }

    return value;
}

module.exports = (tgbot, channel) => {
    console.error = function (message) {
        if (!!message) {
            tgbot.sendMessage(channel, JSON.stringify(message, replaceErrors)).catch((err) => {
                console.log(err)
            });
        }
        this.apply(console, arguments);
    }.bind(console.error);
};
