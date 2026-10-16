// A notification wakes the scheduler immediately; at most one timer is active.
export class WakeSignal {
  constructor(){this.pending=false;this.waiter=null;}
  wake(){if(this.waiter){const f=this.waiter;this.waiter=null;f();}else this.pending=true;}
  wait(ms){
    if(this.pending){this.pending=false;return Promise.resolve();}
    return new Promise(resolve=>{const done=()=>{clearTimeout(timer);if(this.waiter===done)this.waiter=null;resolve();};
      const timer=setTimeout(done,ms);this.waiter=done;});
  }
}
