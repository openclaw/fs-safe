// Process-per-check transport. All filesystem policy remains in the bridge.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

public static class FsSafeWindowsHelper {
  const int Limit = 16 * 1024 * 1024;
  static readonly Encoding Utf8 = new UTF8Encoding(false, true);

  public static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    if(args.Length!=1 || Array.IndexOf(new[]{"path","paths","descriptor","create","directory","protect-file","verify-file"},args[0])<0)
      throw new ArgumentException("Invalid Windows security operation");
    string json=args[0]=="paths" ? Paths() : Json(FsSafeWindowsBridge.Execute(args[0],Environment.GetEnvironmentVariable("FS_SAFE_WINDOWS_SECURITY_PATH")));
    Console.Write(json);
    return 0;
  }

  static Dictionary<string,object> Failure(string code,string message) {
    return new Dictionary<string,object>{{"ok",false},{"code",code},{"message",message}};
  }

  static string Paths() {
    List<string> paths;
    try {
      using(var input=Console.OpenStandardInput()) using(var bytes=new MemoryStream()) {
        var buffer=new byte[8192]; int count;
        while((count=input.Read(buffer,0,buffer.Length))>0) {
          if(bytes.Length+count>Limit) throw new FormatException("Windows security path batch exceeds the input budget");
          bytes.Write(buffer,0,count);
        }
        paths=ParsePaths(Utf8.GetString(bytes.ToArray()));
      }
    } catch(Exception) { return Json(Failure("EINVAL","Invalid Windows security path batch")); }
    const string prefix="{\"ok\":true,\"result\":[", suffix="]}";
    var encoded=new StringBuilder(prefix);
    int bytesUsed=Utf8.GetByteCount(prefix)+Utf8.GetByteCount(suffix);
    string separator="";
    foreach(string path in paths) {
      Dictionary<string,object> reply;
      try { reply=(Dictionary<string,object>)FsSafeWindowsBridge.Execute("path",path); }
      catch(Exception) { reply=Failure("EINVAL","Invalid Windows security path batch"); }
      if(!(bool)reply["ok"]) return Json(reply);
      string rowJson=Json(new Dictionary<string,object>{{"path",path},{"security",reply["result"]}});
      int nextBytes=bytesUsed+separator.Length+Utf8.GetByteCount(rowJson);
      if(nextBytes>Limit) return Json(Failure("too-large","Windows security batch exceeded its output budget"));
      encoded.Append(separator).Append(rowJson);
      bytesUsed=nextBytes;
      separator=",";
    }
    return encoded.Append(suffix).ToString();
  }

  // Accept only the public batch grammar, validating the whole input before any query.
  static List<string> ParsePaths(string input) {
    int at=0; var paths=new List<string>();
    Space(input,ref at); Take(input,ref at,'['); Space(input,ref at);
    if(at<input.Length && input[at]==']') at++;
    else while(true) {
      string path=String(input,ref at);
      if(path.Length==0 || path.IndexOf('\0')>=0) throw new FormatException();
      paths.Add(path); Space(input,ref at);
      if(at<input.Length && input[at]==']') { at++; break; }
      Take(input,ref at,','); Space(input,ref at);
    }
    Space(input,ref at);
    if(at!=input.Length) throw new FormatException();
    return paths;
  }
  static void Space(string input,ref int at) {
    while(at<input.Length && (input[at]==' ' || input[at]=='\t' || input[at]=='\r' || input[at]=='\n')) at++;
  }
  static void Take(string input,ref int at,char expected) {
    if(at>=input.Length || input[at++]!=expected) throw new FormatException();
  }
  static string String(string input,ref int at) {
    Take(input,ref at,'"'); var result=new StringBuilder();
    while(at<input.Length) {
      char c=input[at++];
      if(c=='"') return result.ToString();
      if(c<' ') throw new FormatException();
      if(c=='\\') {
        if(at>=input.Length) throw new FormatException();
        c=input[at++];
        switch(c) {
          case '"': case '\\': case '/': break;
          case 'b': c='\b'; break;
          case 'f': c='\f'; break;
          case 'n': c='\n'; break;
          case 'r': c='\r'; break;
          case 't': c='\t'; break;
          case 'u':
            if(at+4>input.Length) throw new FormatException();
            c=(char)ushort.Parse(input.Substring(at,4),NumberStyles.AllowHexSpecifier,CultureInfo.InvariantCulture);
            at+=4; break;
          default: throw new FormatException();
        }
      }
      result.Append(c);
    }
    throw new FormatException();
  }

  static string Json(object value) {
    var output=new StringBuilder(); Emit(output,value); return output.ToString();
  }
  static void Emit(StringBuilder output,object value) {
    if(value==null) { output.Append("null"); return; }
    if(value is string) { Quote(output,(string)value); return; }
    if(value is bool) { output.Append((bool)value ? "true" : "false"); return; }
    if(value is IDictionary) {
      output.Append('{'); string separator="";
      foreach(DictionaryEntry entry in (IDictionary)value) {
        output.Append(separator); Quote(output,(string)entry.Key); output.Append(':'); Emit(output,entry.Value); separator=",";
      }
      output.Append('}'); return;
    }
    if(value is IEnumerable) {
      output.Append('['); string separator="";
      foreach(object item in (IEnumerable)value) { output.Append(separator); Emit(output,item); separator=","; }
      output.Append(']'); return;
    }
    if(value is byte || value is sbyte || value is short || value is ushort || value is int || value is uint || value is long || value is ulong) {
      output.Append(((IFormattable)value).ToString(null,CultureInfo.InvariantCulture)); return;
    }
    throw new InvalidOperationException("Unsupported Windows security JSON value");
  }
  static void Quote(StringBuilder output,string value) {
    output.Append('"');
    for(int i=0;i<value.Length;i++) {
      char c=value[i];
      switch(c) {
        case '"': output.Append("\\\""); break;
        case '\\': output.Append("\\\\"); break;
        case '\b': output.Append("\\b"); break;
        case '\f': output.Append("\\f"); break;
        case '\n': output.Append("\\n"); break;
        case '\r': output.Append("\\r"); break;
        case '\t': output.Append("\\t"); break;
        default:
          // Escape lone surrogates as JSON rather than letting UTF-8 replace them.
          if(c<' ' || (char.IsSurrogate(c) && !(char.IsHighSurrogate(c) && i+1<value.Length && char.IsLowSurrogate(value[i+1]))))
            output.Append("\\u").Append(((int)c).ToString("x4",CultureInfo.InvariantCulture));
          else { output.Append(c); if(char.IsHighSurrogate(c)) output.Append(value[++i]); }
          break;
      }
    }
    output.Append('"');
  }
}
