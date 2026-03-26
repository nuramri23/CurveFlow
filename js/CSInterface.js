/**
 * CSInterface - Adobe CEP JavaScript interface
 * Full version: https://github.com/Adobe-CEP/CSInterface
 * This is a minimal stub; replace with official CSInterface.js from Adobe CEP SDK
 */
var CSInterface = (function() {
  "use strict";

  function CSInterface() {
    this.hostEnvironment = window.__adobe_cep__ ? JSON.parse(window.__adobe_cep__.getHostEnvironment()) : null;
  }

  CSInterface.prototype.evalScript = function(script, callback) {
    if (window.__adobe_cep__) {
      window.__adobe_cep__.evalScript(script, function(result) {
        if (callback) callback(result);
      });
    } else {
      if (callback) callback('{"success":false,"error":"Not running inside After Effects"}');
    }
  };

  CSInterface.prototype.addEventListener = function(type, listener) {
    if (window.__adobe_cep__) {
      window.__adobe_cep__.addEventListener(type, listener);
    }
  };

  return CSInterface;
}());
