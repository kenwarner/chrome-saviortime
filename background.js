var SaviorTime = {
    canvas: null,
    context: null,
    responseLogs: [],
    productivityWeights: [100, 75, 50, 25, 0],
    productivityOrder: ["Very Productive Time", "Productive Time", "Neutral Time", "Distracting Time", "Very Distracting Time"],
    productivityLabels: ["++", " +", "  ", " -", "--"],

    getApiKey: function () {
        var promise = new Promise(function (resolve, reject) {
            chrome.storage.sync.get('apikey', function (items) {
                resolve(items.apikey);
            });
        });

        return promise;
    },

    setIcon: function (text) {
        text = text || "";

        if (!this.canvas) {
            this.canvas = document.createElement('canvas');
            this.canvas.height = 19;
            this.canvas.width = 19;
            this.context = this.canvas.getContext('2d');
        }

        this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);

        var color = this.calculateColor(text) || 'transparent';
        this.context.fillStyle = color;

        // Set faux rounded corners
        var cornerRadius = 5;
        this.context.lineJoin = "round";
        this.context.lineWidth = cornerRadius;
        this.context.strokeStyle = color;

        // Change origin and dimensions to match true size (a stroke makes the shape a bit larger)
        this.context.strokeRect((cornerRadius / 2), (cornerRadius / 2), this.canvas.width - cornerRadius, this.canvas.height - cornerRadius);
        this.context.fillRect((cornerRadius / 2), (cornerRadius / 2), this.canvas.width - cornerRadius, this.canvas.height - cornerRadius);

        this.context.font = 'bold 10pt Courier New';
        this.context.fillStyle = '#e9e9e9';

        var textWidth = this.context.measureText(text).width;
        this.context.fillText(text, (this.canvas.width / 2) - (textWidth / 2), 14);

        var imageData = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height);
        // chrome.browserAction.setBadgeBackgroundColor({ color: color});
        // chrome.browserAction.setBadgeText({ text: "" + text });
        chrome.browserAction.setIcon({
            imageData: imageData
        });
        chrome.browserAction.setTitle({
            title: "Productivity Pulse: " + text
        });
    },

    calculateColor: function (value) {
        if (value < 0 || value >= 100)
            return null;

        var r1 = Math.floor(207 - 1.945 * value).toString(16);
        var g1 = Math.floor(40 + .825 * value).toString(16);
        var b1 = Math.floor(16 + 1.875 * value).toString(16);

        var r = ('0' + r1).substr(-2);
        var g = ('0' + g1).substr(-2);
        var b = ('0' + b1).substr(-2);

        return '#' + r + g + b;
    },

    getMostRecentLog: function (offset = 0) {
        return SaviorTime.responseLogs[SaviorTime.responseLogs.length - offset - 1];
    },

    calculateTimeSpent: function (seconds) {
        var time = new Date(1000 * seconds).toISOString();
        var hours = time.substr(11, 2);
        var minutes = time.substr(14, 2);
        var timeSpent = hours + "h " + minutes + "m";
        return timeSpent.replace(/00h /, "").replace(/0([\d])/g, "$1").replace(/ 0m/, "");
    },

    calculateProductivityScore: function (offset = 0) {
        var currentLog = SaviorTime.getMostRecentLog(offset);

        if (currentLog == null) {
            return;
        }

        var productivity = 0;
        currentLog.items.forEach(function (log) {
            var weight = SaviorTime.productivityWeights[SaviorTime.productivityLabels.indexOf(log.title)];
            productivity += weight * log.seconds;
        });

        return Math.round(productivity / currentLog.totalSeconds);
    },

    generateProductivityGraph: function (offset = 0) {
        var barSize = 18;
        var barGap = 1;
        var maxMessageSize = 18;
        var log = SaviorTime.getMostRecentLog(offset);

        if (log == null) {
            return;
        }

        var items = log.items.map(function (item) {
            // pad percents < 10 with 2 spaces to create vertical alignment
            var title = ("|||" + item.percentMessage).slice(-3).replace(/^[|]/, "  ");
            var graph = "▆".repeat(item.percent / log.maxPercent * barSize);
            var timeSpent = (item.timeSpent.replace(/\|/g, " "));
            var timeDelta = item.secondsDelta >= 60 ? " +" + Math.round(item.secondsDelta / 60.0) + "m" : "";
            var timeMessage = timeSpent + timeDelta;
            var message = graph + " " + timeMessage;

            // if the time overflows the graph, inline it into the graph
            if (message.length > maxMessageSize) {
                var g1 = graph.substr(0, graph.length - timeMessage.length - barGap - 1);
                var g2 = graph.substr(g1.length + timeMessage.length - 2, barGap);
                message = g2 + " " + timeMessage + " " + g1;
            }

            return {
                title: title,
                message: message
            }
        });

        return items;
    },

    showNotification: function (offset = 0) {
        var log = SaviorTime.getMostRecentLog(offset);

        if (log == null) {
            return;
        }

        var opts = {
            type: "list",
            iconUrl: "rescuetime.png",
            buttons: [{
                    title: "Today"
                },
                {
                    title: "This week"
                }
            ]
        };

        var asof = Math.round((Date.now() - log.timestamp) / 60/1000);
        opts.title = opts.message = "Productivity Pulse: " + SaviorTime.calculateProductivityScore(offset) + "\r" + log.timeSpent + " as of " + asof + "m ago";
        opts.items = SaviorTime.generateProductivityGraph(offset);

        // notifications.create will fail if items is empty
        if (opts.items.length <= 0) {
            return;
        }

        chrome.notifications.create(opts);
    },

    updateData: function () {
        var promise = new Promise(function (resolve, reject) {
            var data = null;

            var xhr = new XMLHttpRequest();
            xhr.withCredentials = true;

            xhr.addEventListener("readystatechange", function () {
                if (this.readyState === 4) {
                    if (this.status !== 200) { reject(); }

                    var response = JSON.parse(this.responseText);

                    var currentLog = {
                        timestamp: Date.now(),
                        items: []
                    };

                    response.rows.forEach(function (row) {
                        var timeCategory = SaviorTime.productivityLabels[SaviorTime.productivityOrder.indexOf(row[3])];
                        var seconds = row[1];

                        // calculate time spent
                        var timeSpent = SaviorTime.calculateTimeSpent(seconds);

                        // did we increase since last time?
                        var secondsDelta = null;
                        if (SaviorTime.responseLogs.length > 0) {
                            var firstResponse = SaviorTime.getMostRecentLog();

                            if (firstResponse !== null) {
                                var categoryItem = firstResponse.items.find(function (item) {
                                    return item.title == timeCategory
                                });

                                if (categoryItem !== null && seconds > categoryItem.seconds) {
                                    secondsDelta = seconds - categoryItem.seconds;
                                }
                            }
                        }

                        currentLog.items.push({
                            title: timeCategory,
                            seconds: seconds,
                            secondsDelta: secondsDelta,
                            timeSpent: timeSpent
                        });
                    });

                    // calculate total seconds
                    currentLog.totalSeconds = currentLog.items.reduce(function (a, b) {
                        return a + b.seconds;
                    }, 0);
                    currentLog.timeSpent = SaviorTime.calculateTimeSpent(currentLog.totalSeconds);

                    // calculate percentage by productivity category
                    currentLog.items.sort(function (a, b) {
                        return SaviorTime.productivityLabels.indexOf(a.title) > SaviorTime.productivityLabels.indexOf(b.title);
                    }).map(function (log) {
                        var percent = Math.round(log.seconds / currentLog.totalSeconds * 100);
                        log.percent = percent;
                        log.percentMessage = "" + percent + "%";
                    });

                    // calculate max percent
                    currentLog.maxPercent = currentLog.items.reduce(function (a, b) {
                        return (a.percent > b.percent) ? a : b;
                    }, 0).percent;

                    // only save this response if it's the first one, or it is different from the most recent one
                    var mostRecentLog = SaviorTime.getMostRecentLog();
                    var hasNewData = (mostRecentLog == null || 
                        new Date(currentLog.timestamp).getDay() != new Date(mostRecentLog.timestamp).getDay() || 
                        currentLog.totalSeconds > mostRecentLog.totalSeconds);
                    if (hasNewData) {
                        SaviorTime.responseLogs.push(currentLog);
                    }

                    SaviorTime.responseLogs = SaviorTime.responseLogs.slice(-10); // keep only the last 10
                    chrome.storage.sync.set({ responseLogs: SaviorTime.responseLogs });
                    resolve(hasNewData);
                }
            });

            SaviorTime.getApiKey().then(function (apikey) {
                var url = "https://www.rescuetime.com/anapi/data?format=json&interval=minute&ty=efficiency&key=" + apikey;
                xhr.open("GET", url);
                xhr.send(data);
            });
        });

        return promise;
    },

    update: function (forceShowNotification = false) {
        var promise = new Promise(function (resolve, reject) {
            SaviorTime.updateData().then(function (hasNewData) {
                if (forceShowNotification || hasNewData) {
                    SaviorTime.showNotification();
                    SaviorTime.setIcon(SaviorTime.calculateProductivityScore());
                }

                resolve();
            });
        });

        return promise;
    }

};

chrome.runtime.onInstalled.addListener(function () {
    chrome.alarms.onAlarm.addListener(function(alarm) { 
        SaviorTime.update(); 
    });
    chrome.alarms.create('refresh', {
        periodInMinutes: 3
    });
});

chrome.browserAction.onClicked.addListener(function () {
    SaviorTime.update(true).then(function() {

        if (false) { // enable for debugging notifications
            for (var offset = 1; offset < SaviorTime.responseLogs.length; offset++) {
                SaviorTime.showNotification(offset);
            }
        }
    });
});

chrome.notifications.onClicked.addListener(function (notificationId) {
    chrome.notifications.clear(notificationId);
});

chrome.notifications.onButtonClicked.addListener(function (notificationId, buttonIndex) {
    switch (buttonIndex) {
        case 0:
            window.open("https://www.rescuetime.com/browse/productivity/by/hour/for/the/day/of/today");
            break;
        case 1:
            window.open("https://www.rescuetime.com/dashboard/for/the/week/of/this-week");
            break;
    }
});

chrome.storage.sync.get('responseLogs', function(items) { 
    SaviorTime.responseLogs = items.responseLogs || [];

    // start with one update
    SaviorTime.update(true);
});
