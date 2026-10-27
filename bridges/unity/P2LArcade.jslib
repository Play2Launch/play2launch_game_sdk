mergeInto(LibraryManager.library, {
  P2LArcade_Init: function(origin) {
    if (window.p2lArcade) window.p2lArcade.destroy();
    window.p2lArcade = window.P2LGameSDK.createArcadeSDK({parentOrigin:UTF8ToString(origin)});
  },
  P2LArcade_Call: function(objectName, requestID, method, argumentsJSON) {
    var target=UTF8ToString(objectName), id=UTF8ToString(requestID), name=UTF8ToString(method);
    var args=JSON.parse(UTF8ToString(argumentsJSON));
    var allowed=['ready','loading','getUserProfile','getData','setData','report','getTasks','getBalance','getProducts','requestPayment','openInvoice','purchase','getOrder','getOrders','confirmDelivery','exit'];
    Promise.resolve().then(function(){
      if(allowed.indexOf(name)<0 || !Array.isArray(args)) throw Error('Invalid SDK call');
      return window.p2lArcade[name].apply(window.p2lArcade,args);
    }).then(function(data){SendMessage(target,'OnP2LArcadeResult',JSON.stringify({id:id,state:'success',data:data}));},function(error){SendMessage(target,'OnP2LArcadeResult',JSON.stringify({id:id,state:'error',message:error.message}));});
  },
  P2LArcade_Destroy: function(){if(window.p2lArcade){window.p2lArcade.destroy();delete window.p2lArcade;}}
});
