/*
  2022-05-20

  The author disclaims copyright to this source code.  In place of a
  legal notice, here is a blessing:

  *   May you do good and not evil.
  *   May you find forgiveness for yourself and forgive others.
  *   May you share freely, never taking more than you give.

  ***********************************************************************

  This is the main entry point for the sqlite3 fiddle app. It sets up the
  various UI bits, loads a Worker for the db connection, and manages the
  communication between the UI and worker.
*/
(function(){
    'use strict';

    /* Recall that the 'self' symbol, except where locally
       overwritten, refers to the global window or worker object. */

    /**
       The SqliteFiddle object is intended to be the primary
       app-level object for the main-thread side of the sqlite
       fiddle application. It uses a worker thread to load the
       sqlite WASM module and communicate with it.
    */
    const SF/*local convenience alias*/
    = window.SqliteFiddle/*canonical name*/ = {
        /* Config options. */
        config: {
            /* If true, SqliteFiddle.echo() will auto-scroll the
               output widget to the bottom when it receives output,
               else it won't. */
            autoScrollOutput: true,
            /* If true, the output area will be cleared before each
               command is run, else it will not. */
            autoClearOutput: false,
            /* If true, SqliteFiddle.echo() will echo its output to
               the console, in addition to its normal output widget.
               That slows it down but is useful for testing. */
            echoToConsole: false,
            /* If true, display input/output areas side-by-side. */
            sideBySide: false,
            /* If true, swap positions of the input/output areas. */
            swapInOut: false
        },
        /**
           Emits the given text, followed by a line break, to the
           output widget.  If given more than one argument, they are
           join()'d together with a space between each. As a special
           case, if passed a single array, that array is used in place
           of the arguments array (this is to facilitate receiving
           lists of arguments via worker events).
        */
        echo: function f(text) {
            /* Maintenance reminder: we currently require/expect a textarea
               output element. It might be nice to extend this to behave
               differently if the output element is a non-textarea element,
               in which case it would need to append the given text as a TEXT
               node and add a line break. */
            if(!f._){
                f._ = document.getElementById('output');
                f._.value = ''; // clear browser cache
            }
            if(arguments.length > 1) text = Array.prototype.slice.call(arguments).join(' ');
            else if(1===arguments.length && Array.isArray(text)) text = text.join(' ');
            // These replacements are necessary if you render to raw HTML
            //text = text.replace(/&/g, "&amp;");
            //text = text.replace(/</g, "&lt;");
            //text = text.replace(/>/g, "&gt;");
            //text = text.replace('\n', '<br>', 'g');
            if(null===text){/*special case: clear output*/
                f._.value = '';
                return;
            }else if(this.echo._clearPending){
                delete this.echo._clearPending;
                f._.value = '';
            }
            if(this.config.echoToConsole) console.log(text);
            if(this.jqTerm) window.Module.jqTerm.echo(text);
            f._.value += text + "\n";
            if(this.config.autoScrollOutput){
                f._.scrollTop = f._.scrollHeight;
            }
        },
        _msgMap: {},
        addMsgHandler: function f(type,callback){
            if(Array.isArray(type)){
                type.forEach((t)=>this.addMsgHandler(t, callback));
                return this;
            }
            (this._msgMap.hasOwnProperty(type)
             ? this._msgMap[type]
             : (this._msgMap[type] = [])).push(callback);
            return this;
        },
        runMsgHandlers: function(msg){
            const list = (this._msgMap.hasOwnProperty(msg.type)
                          ? this._msgMap[msg.type] : false);
            if(!list){
                console.warn("No handlers found for message type:",msg);
                return false;
            }
            //console.debug("runMsgHandlers",msg);
            list.forEach((f)=>f(msg));
            return true;
        },
        clearMsgHandlers: function(type){
            delete this._msgMap[type];
            return this;
        },
        /* Posts a message in the form {type, data} to the db worker. Returns this. */
        wMsg: function(type,data){
            this.worker.postMessage({type, data});
            return this;
        }
    };

    SF.worker = new Worker('fiddle-worker.js');
    SF.worker.onmessage = (ev)=>SF.runMsgHandlers(ev.data);
    SF.addMsgHandler(['stdout', 'stderr'], (ev)=>SF.echo(ev.data));

    /* querySelectorAll() proxy */
    const EAll = function(/*[element=document,] cssSelector*/){
        return (arguments.length>1 ? arguments[0] : document)
            .querySelectorAll(arguments[arguments.length-1]);
    };
    /* querySelector() proxy */
    const E = function(/*[element=document,] cssSelector*/){
        return (arguments.length>1 ? arguments[0] : document)
            .querySelector(arguments[arguments.length-1]);
    };
    
    const statusElement = E('#module-status');
    const progressElement = E('#module-progress');
    const spinnerElement = E('#module-spinner');

    SF.addMsgHandler('module', function f(ev){
        ev = ev.data;
        if('status'!==ev.type){
            console.warn("Unexpected module-type message:",ev);
            return;
        }
        const msg = ev.data;
        progressElement.value = msg.step;
        progressElement.max = msg.step + 1/*we don't know how many steps to expect*/;
        if(1==msg.step){
            progressElement.hidden = false;
            spinnerElement.hidden = false;
        }
        if(msg.text){
            statusElement.classList.remove('hidden');
            statusElement.innerText = msg.text;
        }else{
            progressElement.remove();
            spinnerElement.remove();
            statusElement.classList.add('hidden');
            /* The module can post messages about fatal problems,
               e.g. an exit() being triggered or assertion failure,
               after the last "load" message has arrived, so
               leave the statusElement and message listener intact. */
        }
    });

    /**
       The 'fiddle-ready' event is fired (with no payload) when the
       wasm module has finished loading. Interestingly, that happens
       _before_ the final module:status event */
    SF.addMsgHandler('fiddle-ready', function(){
        SF.clearMsgHandlers('fiddle-ready');
        self.onSFLoaded();
    });

    /**
       Performs all app initialization which must wait until after the
       worker module is loaded. This function removes itself when it's
       called.
    */
    self.onSFLoaded = function(){
        delete this.onSFLoaded;
        // Unhide all elements which start out hidden
        EAll('.initially-hidden').forEach((e)=>e.classList.remove('initially-hidden'));
        
        const taInput = E('#input');
        const btnClearIn = E('#btn-clear');
        btnClearIn.addEventListener('click',function(){
            taInput.value = '';
        },false);
        // Ctrl-enter and shift-enter both run the current SQL.
        taInput.addEventListener('keydown',function(ev){
            if((ev.ctrlKey || ev.shiftKey) && 13 === ev.keyCode){
                ev.preventDefault();
                ev.stopPropagation();
                btnShellExec.click();
            }
        }, false);
        const taOutput = E('#output');
        const btnClearOut = E('#btn-clear-output');
        btnClearOut.addEventListener('click',function(){
            taOutput.value = '';
            if(SF.jqTerm) SF.jqTerm.clear();
        },false);
        const btnShellExec = E('#btn-shell-exec');
        btnShellExec.addEventListener('click',function(){
            const sql = taInput.value.trim();
            if(sql) SF.dbExec(sql);
        },false);

        /** To be called immediately before work is sent to the
            worker.  Updates some UI elements. The 'working'/'end'
            event will apply the inverse, undoing the bits this
            function does.  This impl is not in the 'working'/'start'
            event handler because that event is given to us
            asynchronously _after_ we need to have performed this
            work.
        */
        const preStartWork = function f(){
            if(!f._){
                const title = E('title');
                f._ = {
                    btnLabel: btnShellExec.innerText,
                    pageTitle: title,
                    pageTitleOrig: title.innerText
                };
            }
            f._.pageTitle.innerText = "[working...] "+f._.pageTitleOrig;
            btnShellExec.setAttribute('disabled','disabled');
        };

        /* Sends the given text to the db module to evaluate as if it
           had been entered in the sqlite3 CLI shell. If it's null or
           empty, this is a no-op except that the very first call will
           initialize the db and output an informational header. */
        SF.dbExec = function f(sql){
            if(this.config.autoClearOutput){
                this.echo._clearPending = true;
            }
            preStartWork();
            this.wMsg('shellExec',sql);
        };

        SF.addMsgHandler('working',function f(ev){
            if('start' === ev.data){
                /* See notes in preStartWork(). */
            }else if('end' === ev.data){
                preStartWork._.pageTitle.innerText = preStartWork._.pageTitleOrig;
                btnShellExec.innerText = preStartWork._.btnLabel;
                btnShellExec.removeAttribute('disabled');
            }
        });

        /* For each checkbox with data-csstgt, set up a handler which
           toggles the given CSS class on the element matching
           E(data-csstgt). */
        EAll('input[type=checkbox][data-csstgt]')
            .forEach(function(e){
                const tgt = E(e.dataset.csstgt);
                const cssClass = e.dataset.cssclass || 'error';
                e.checked = tgt.classList.contains(cssClass);
                e.addEventListener('change', function(){
                    tgt.classList[
                        this.checked ? 'add' : 'remove'
                    ](cssClass)
                }, false);
            });
        /* For each checkbox with data-config=X, set up a binding to
           SF.config[X]. These must be set up AFTER data-csstgt
           checkboxes so that those two states can be synced properly. */
        EAll('input[type=checkbox][data-config]')
            .forEach(function(e){
                const confVal = !!SF.config[e.dataset.config];
                if(e.checked !== confVal){
                    /* Ensure that data-csstgt mappings (if any) get
                       synced properly. */
                    e.checked = confVal;
                    e.dispatchEvent(new Event('change'));
                }
                e.addEventListener('change', function(){
                    SF.config[this.dataset.config] = this.checked;
                }, false);
            });
        /* For each button with data-cmd=X, map a click handler which
           calls dbExec(X). */
        const cmdClick = function(){SF.dbExec(this.dataset.cmd);};
        EAll('button[data-cmd]').forEach(
            e => e.addEventListener('click', cmdClick, false)
        );

        /**
           Given a DOM element, this routine measures its "effective
           height", which is the bounding top/bottom range of this element
           and all of its children, recursively. For some DOM structure
           cases, a parent may have a reported height of 0 even though
           children have non-0 sizes.

           Returns 0 if !e or if the element really has no height.
        */
        const effectiveHeight = function f(e){
            if(!e) return 0;
            if(!f.measure){
                f.measure = function callee(e, depth){
                    if(!e) return;
                    const m = e.getBoundingClientRect();
                    if(0===depth){
                        callee.top = m.top;
                        callee.bottom = m.bottom;
                    }else{
                        callee.top = m.top ? Math.min(callee.top, m.top) : callee.top;
                        callee.bottom = Math.max(callee.bottom, m.bottom);
                    }
                    Array.prototype.forEach.call(e.children,(e)=>callee(e,depth+1));
                    if(0===depth){
                        //console.debug("measure() height:",e.className, callee.top, callee.bottom, (callee.bottom - callee.top));
                        f.extra += callee.bottom - callee.top;
                    }
                    return f.extra;
                };
            }
            f.extra = 0;
            f.measure(e,0);
            return f.extra;
        };

        /**
           Returns a function, that, as long as it continues to be invoked,
           will not be triggered. The function will be called after it stops
           being called for N milliseconds. If `immediate` is passed, call
           the callback immediately and hinder future invocations until at
           least the given time has passed.

           If passed only 1 argument, or passed a falsy 2nd argument,
           the default wait time set in this function's $defaultDelay
           property is used.

           Source: underscore.js, by way of https://davidwalsh.name/javascript-debounce-function
        */
        const debounce = function f(func, wait, immediate) {
            var timeout;
            if(!wait) wait = f.$defaultDelay;
            return function() {
                const context = this, args = Array.prototype.slice.call(arguments);
                const later = function() {
                    timeout = undefined;
                    if(!immediate) func.apply(context, args);
                };
                const callNow = immediate && !timeout;
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
                if(callNow) func.apply(context, args);
            };
        };
        debounce.$defaultDelay = 500 /*arbitrary*/;

        const ForceResizeKludge = (function(){
            /* Workaround for Safari mayhem regarding use of vh CSS units....
               We cannot use vh units to set the terminal area size because
               Safari chokes on that, so we calculate that height here. Larger
               than ~95% is too big for Firefox on Android, causing the input
               area to move off-screen. */
            const bcl = document.body.classList;
            const appViews = EAll('.app-view');
            const resized = function f(){
                if(f.$disabled) return;
                const wh = window.innerHeight;
                var ht;
                var extra = 0;
                const elemsToCount = [
                    E('body > header'),
                    E('body > footer')
                ];
                elemsToCount.forEach((e)=>e ? extra += effectiveHeight(e) : false);
                ht = wh - extra;
                appViews.forEach(function(e){
                    e.style.height =
                        e.style.maxHeight = [
                            "calc(", (ht>=100 ? ht : 100), "px",
                            " - 2em"/*fudge value*/,")"
                            /* ^^^^ hypothetically not needed, but both
                               Chrome/FF on Linux will force scrollbars on the
                               body if this value is too small. */
                        ].join('');
                });
            };
            resized.$disabled = true/*gets deleted when setup is finished*/;
            window.addEventListener('resize', debounce(resized, 250), false);
            return resized;
        })();

        /** Set up a selection list of examples */
        (function(){
            const xElem = E('#select-examples');
            const examples = [
                {name: "Timer on", sql: ".timer on"},
                {name: "Setup table T", sql:`.nullvalue NULL
CREATE TABLE t(a,b);
INSERT INTO t(a,b) VALUES('abc',123),('def',456),(NULL,789),('ghi',012);
SELECT * FROM t;`},
                {name: "Table list", sql: ".tables"},
                {name: "Box Mode", sql: ".mode box"},
                {name: "JSON Mode", sql: ".mode json"},
                {name: "Mandlebrot", sql: `WITH RECURSIVE
  xaxis(x) AS (VALUES(-2.0) UNION ALL SELECT x+0.05 FROM xaxis WHERE x<1.2),
  yaxis(y) AS (VALUES(-1.0) UNION ALL SELECT y+0.1 FROM yaxis WHERE y<1.0),
  m(iter, cx, cy, x, y) AS (
    SELECT 0, x, y, 0.0, 0.0 FROM xaxis, yaxis
    UNION ALL
    SELECT iter+1, cx, cy, x*x-y*y + cx, 2.0*x*y + cy FROM m 
     WHERE (x*x + y*y) < 4.0 AND iter<28
  ),
  m2(iter, cx, cy) AS (
    SELECT max(iter), cx, cy FROM m GROUP BY cx, cy
  ),
  a(t) AS (
    SELECT group_concat( substr(' .+*#', 1+min(iter/7,4), 1), '') 
    FROM m2 GROUP BY cy
  )
SELECT group_concat(rtrim(t),x'0a') as Mandelbrot FROM a;`}
            ];
            const newOpt = function(lbl,val){
                const o = document.createElement('option');
                o.value = val;
                if(!val) o.setAttribute('disabled',true);
                o.appendChild(document.createTextNode(lbl));
                xElem.appendChild(o);
            };
            newOpt("Examples (replaces input!)");
            examples.forEach((o)=>newOpt(o.name, o.sql));
            //xElem.setAttribute('disabled',true);
            xElem.selectedIndex = 0;
            xElem.addEventListener('change', function(){
                taInput.value = '-- ' +
                    this.selectedOptions[0].innerText +
                    '\n' + this.value;
                //dbExec(this.value);
            });
        })()/* example queries */;

        SF.echo(null/*clear any output generated by the init process*/);
        if(window.jQuery && window.jQuery.terminal){
            /* Set up the terminal-style view... */
            const eTerm = window.jQuery('#view-terminal').empty();
            SF.jqTerm = eTerm.terminal(dbExec,{
                prompt: 'sqlite> ',
                greetings: false /* note that the docs incorrectly call this 'greeting' */
            });
            /* Set up a button to toggle the views... */
            const head = E('header#titlebar');
            const btnToggleView = document.createElement('button');
            btnToggleView.appendChild(document.createTextNode("Toggle View"));
            btnToggleView.addEventListener('click',function f(){
                EAll('.app-view').forEach(e=>e.classList.toggle('hidden'));
                if(document.body.classList.toggle('terminal-mode')){
                    ForceResizeKludge();
                }
            }, false);
            btnToggleView.click()/*default to terminal view*/;
        }
        SF.dbExec(null/*init the db and output the header*/);
        SF.echo('This experimental app is provided in the hope that it',
                'may prove interesting or useful but is not an officially',
                'supported deliverable of the sqlite project. It is subject to',
                'any number of changes or outright removal at any time.\n');
        delete ForceResizeKludge.$disabled;
        ForceResizeKludge();
    }/*onSFLoaded()*/;
})();
