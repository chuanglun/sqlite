/*
  2022-05-20

  The author disclaims copyright to this source code.  In place of a
  legal notice, here is a blessing:

  *   May you do good and not evil.
  *   May you find forgiveness for yourself and forgive others.
  *   May you share freely, never taking more than you give.

  ***********************************************************************

  This is the JS Worker file for the sqlite3 fiddle app. It loads the
  sqlite3 wasm module and offers access to the db via the Worker
  message-passing interface.

  Forewarning: this API is still very much Under Construction and
  subject to any number of changes as experience reveals what those
  need to be.

  Because we can have only a single message handler, as opposed to an
  arbitrary number of discrete event listeners like with DOM elements,
  we have to define a lower-level message API. Messages abstractly
  look like:

  { type: string, data: type-specific value }

  Where 'type' is used for dispatching and 'data' is a
  'type'-dependent value.

  The 'type' values expected by each side of the main/worker
  connection vary. The types are described below but subject to
  change at any time as this experiment evolves.

  Workers-to-Main types

  - stdout, stderr: indicate stdout/stderr output from the wasm
    layer. The data property is the string of the output, noting
    that the emscripten binding emits these one line at a time. Thus,
    if a C-side puts() emits multiple lines in a single call, the JS
    side will see that as multiple calls. Example:

    {type:'stdout', data: 'Hi, world.'}

  - module: Status text. This is intended to alert the main thread
    about module loading status so that, e.g., the main thread can
    update a progress widget and DTRT when the module is finished
    loading and available for work. Status messages come in the form
    
    {type:'module', data:{
        type:'status',
        data: {text:string|null, step:1-based-integer}
    }

    with an incrementing step value for each subsequent message. When
    the module loading is complete, a message with a text value of
    null is posted.

  - working: data='start'|'end'. Indicates that work is about to be
    sent to the module or has just completed. This can be used, e.g.,
    to disable UI elements which should not be activated while work
    is pending. Example:

    {type:'working', data:'start'}

  Main-to-Worker types:

  - shellExec: data=text to execute as if it had been entered in the
    sqlite3 CLI shell app (as opposed to sqlite3_exec()). This event
    causes the worker to emit a 'working' event (data='start') before
    it starts and a 'working' event (data='end') when it finished. If
    called while work is currently being executed it emits stderr
    message instead of doing actual work, as the underlying db cannot
    handle concurrent tasks. Example:

    {type:'shellExec', data: 'select * from sqlite_master'}

  - More TBD as the higher-level db layer develops.
*/

/*
  Apparent browser(s) bug: console messages emitted may be duplicated
  in the console, even though they're provably only run once. See:

  https://stackoverflow.com/questions/49659464

  Noting that it happens in Firefox as well as Chrome. Harmless but
  annoying.
*/
"use strict";

const wMsg = (type,data)=>postMessage({type, data});

self.onerror = function(/*message, source, lineno, colno, error*/) {
    const err = arguments[4];
    if(err && 'ExitStatus'==err.name){
        /* This is relevant for the sqlite3 shell binding but not the
           lower-level binding. */
        Module._isDead = true;
        Module.printErr("FATAL ERROR:", err.message);
        Module.printErr("Restarting the app requires reloading the page.");
        wMsg('error', err);
    }
    Module.setStatus('Exception thrown, see JavaScript console');
    Module.setStatus = function(text) {
        console.error('[post-exception status]', text);
    };
};

self.Module = {
/* ^^^ cannot declare that const because fiddle-module.js
   (auto-generated) includes a decl for it and runs in this scope. */
    preRun: [],
    postRun: [],
    //onRuntimeInitialized: function(){},
    print: function(text){wMsg('stdout', Array.prototype.slice.call(arguments));},
    printErr: function(text){wMsg('stderr', Array.prototype.slice.call(arguments));},
    /**
       Intercepts status updates from the Module object and fires
       worker events with a type of 'status' and a payload of:

       {
         text: string | null, // null at end of load process
         step: integer // starts at 1, increments 1 per call
       }

       We have no way of knowing in advance how many steps will
       be processed/posted, so creating a "percentage done" view is
       not really practical. One can be approximated by giving it a
       current value of message.step and max value of message.step+1,
       though.

       When work is finished, a message with a text value of null is
       submitted.

       After a message with text==null is posted, the module may later
       post messages about fatal problems, e.g. an exit() being
       triggered, so it is recommended that UI elements for posting
       status messages not be outright removed from the DOM when
       text==null, and that they instead be hidden until/unless
       text!=null.
    */
    setStatus: function f(text){
        if(!f.last) f.last = { step: 0, text: '' };
        else if(text === f.last.text) return;
        f.last.text = text;
        wMsg('module',{
            type:'status',
            data:{step: ++f.last.step, text: text||null}
        });
    },
    totalDependencies: 0,
    monitorRunDependencies: function(left) {
        this.totalDependencies = Math.max(this.totalDependencies, left);
        this.setStatus(left
                       ? ('Preparing... (' + (this.totalDependencies-left)
                          + '/' + this.totalDependencies + ')')
                       : 'All downloads complete.');
    }
};

const shellExec = function f(sql){
    if(!f._) f._ = Module.cwrap('fiddle_exec', null, ['string']);
    if(Module._isDead){
        wMsg('stderr', "shell module has exit()ed. Cannot run SQL.");
        return;
    }
    wMsg('working','start');
    try {
        if(f._running) wMsg('stderr','Cannot run multiple commands concurrently.');
        else{
            f._running = true;
            f._(sql);
        }
    } finally {
        wMsg('working','end');
        delete f._running;
    }
};

self.onmessage = function(ev){
    ev = ev.data;
    //console.debug("worker: onmessage.data",ev);
    switch(ev.type){
        case 'shellExec': shellExec(ev.data); return;
    };
    console.warn("Unknown fiddle-worker message type:",ev);
};
self.Module.setStatus('Downloading...');
importScripts('fiddle-module.js')
/* loads the wasm module and notifies, via Module.setStatus() and
   Module.onRuntimeInitialized(), when it's done loading.  The latter
   is called _before_ the final call to Module.setStatus(). */;

Module["onRuntimeInitialized"] = function onRuntimeInitialized() {
    wMsg('fiddle-ready');
};
