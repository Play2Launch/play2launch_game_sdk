using System;
using System.Runtime.InteropServices;
using UnityEngine;

// Optional native P2L services. Existing DashFunBridge components stay intact.
public class P2LArcadeBridge : MonoBehaviour {
    [DllImport("__Internal")] private static extern void P2LArcade_Init(string origin);
    [DllImport("__Internal")] private static extern void P2LArcade_Call(string target,string id,string method,string argumentsJSON);
    [DllImport("__Internal")] private static extern void P2LArcade_Destroy();
    public event Action<string> Result;
    public void Initialize(string trustedParentOrigin) {
#if UNITY_WEBGL && !UNITY_EDITOR
        P2LArcade_Init(trustedParentOrigin);
#endif
    }
    // JSON argument array uses the same positional arguments as createArcadeSDK.
    public string Call(string method,string argumentsJSON="[]") {
        var id=Guid.NewGuid().ToString();
#if UNITY_WEBGL && !UNITY_EDITOR
        P2LArcade_Call(gameObject.name,id,method,argumentsJSON);
#else
        throw new NotSupportedException("P2L arcade requires a WebGL iframe host");
#endif
        return id;
    }
    public void OnP2LArcadeResult(string json) { Result?.Invoke(json); }
    private void OnDestroy() {
#if UNITY_WEBGL && !UNITY_EDITOR
        P2LArcade_Destroy();
#endif
    }
}
