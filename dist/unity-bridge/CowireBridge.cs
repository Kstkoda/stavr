// CowireBridge.cs — Editor-only bridge between Unity and Cowire.
//
// Drop this file at <YourUnityProject>/Assets/Editor/Cowire/CowireBridge.cs.
// It runs automatically when the Editor opens, and writes one JSON event per
// line to <YourUnityProject>/Logs/cowire-events.jsonl. The Cowire `unity`
// worker tails that file and surfaces events as worker_progress, errors as
// worker_error, and lifecycle changes as worker_metadata_changed.
//
// Why a file, not HTTP/TCP: Unity domain-reloads on every script change,
// killing in-process sockets. File appends survive reloads, crashes, batch
// mode, and Editor restarts. See docs/unity-worker.md and the ADR.
//
// Compatibility: Unity 2020.3+ (uses UnityEditor.Compilation.CompilationPipeline
// and Application.logMessageReceivedThreaded which are stable since 2018.x).

#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

namespace Cowire
{
    [InitializeOnLoad]
    public static class CowireBridge
    {
        private const string LogsFolder = "Logs";
        private const string LogFileName = "cowire-events.jsonl";
        private const long RotateAtBytes = 5 * 1024 * 1024; // 5 MB
        private static readonly object WriteLock = new object();
        private static int _errorCount;
        private static int _warningCount;
        private static string _currentAssembly = "";

        static CowireBridge()
        {
            try
            {
                // Compilation events — the heart of the feedback loop.
                CompilationPipeline.compilationStarted += OnCompilationStarted;
                CompilationPipeline.assemblyCompilationStarted += OnAssemblyStarted;
                CompilationPipeline.assemblyCompilationFinished += OnAssemblyFinished;
                CompilationPipeline.compilationFinished += OnCompilationFinished;

                // Domain reload signals — useful for the worker to know the
                // Editor is briefly unresponsive.
                AssemblyReloadEvents.beforeAssemblyReload += OnBeforeReload;
                AssemblyReloadEvents.afterAssemblyReload += OnAfterReload;

                // Play-mode lifecycle + runtime exceptions.
                EditorApplication.playModeStateChanged += OnPlayModeChanged;
                Application.logMessageReceivedThreaded += OnLogReceived;

                Write(new Dictionary<string, object>
                {
                    { "type", "editor_log" },
                    { "level", "info" },
                    { "message", "CowireBridge initialized" },
                });
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[Cowire] bridge init failed: " + ex);
            }
        }

        // ---- compilation -----------------------------------------------------

        private static void OnCompilationStarted(object _)
        {
            _errorCount = 0;
            _warningCount = 0;
            Write(new Dictionary<string, object> { { "type", "compile_start" } });
        }

        private static void OnAssemblyStarted(string assemblyPath)
        {
            _currentAssembly = Path.GetFileNameWithoutExtension(assemblyPath);
        }

        private static void OnAssemblyFinished(string assemblyPath, CompilerMessage[] messages)
        {
            int errors = 0, warnings = 0;
            foreach (var m in messages)
            {
                bool isError = m.type == CompilerMessageType.Error;
                if (isError) errors++; else warnings++;

                Write(new Dictionary<string, object>
                {
                    { "type", isError ? "compile_error" : "compile_warning" },
                    { "assembly", Path.GetFileNameWithoutExtension(assemblyPath) },
                    { "file", m.file ?? "" },
                    { "line", m.line },
                    { "column", m.column },
                    { "message", m.message ?? "" },
                });
            }
            _errorCount += errors;
            _warningCount += warnings;
        }

        private static void OnCompilationFinished(object _)
        {
            Write(new Dictionary<string, object>
            {
                { "type", "compile_finish" },
                { "assembly", _currentAssembly },
                { "errors", _errorCount },
                { "warnings", _warningCount },
            });
        }

        // ---- domain reload ---------------------------------------------------

        private static void OnBeforeReload()
        {
            Write(new Dictionary<string, object> { { "type", "reload_start" } });
        }

        private static void OnAfterReload()
        {
            Write(new Dictionary<string, object> { { "type", "reload_finish" } });
        }

        // ---- play mode -------------------------------------------------------

        private static void OnPlayModeChanged(PlayModeStateChange change)
        {
            switch (change)
            {
                case PlayModeStateChange.EnteredPlayMode:
                    Write(new Dictionary<string, object> { { "type", "play_mode_enter" } });
                    break;
                case PlayModeStateChange.ExitingPlayMode:
                    Write(new Dictionary<string, object> { { "type", "play_mode_exit" } });
                    break;
            }
        }

        private static void OnLogReceived(string condition, string stackTrace, LogType type)
        {
            // Only surface errors/exceptions to keep the JSONL signal-rich. Warnings
            // and info logs are still in Editor.log if a user needs them.
            if (type != LogType.Error && type != LogType.Exception && type != LogType.Assert)
                return;

            // During play mode this is the main signal that gameplay code blew up.
            string kind = EditorApplication.isPlaying ? "play_mode_error" : "editor_log";
            Write(new Dictionary<string, object>
            {
                { "type", kind },
                { "level", "error" },
                { "message", condition ?? "" },
                { "stack", stackTrace ?? "" },
            });
        }

        // ---- writer ----------------------------------------------------------

        private static void Write(Dictionary<string, object> evt)
        {
            try
            {
                evt["timestamp"] = DateTime.UtcNow.ToString("o");
                string line = ToJson(evt);

                lock (WriteLock)
                {
                    string projectRoot = Path.GetDirectoryName(Application.dataPath);
                    string logsDir = Path.Combine(projectRoot, LogsFolder);
                    if (!Directory.Exists(logsDir)) Directory.CreateDirectory(logsDir);

                    string path = Path.Combine(logsDir, LogFileName);
                    RotateIfTooBig(path);

                    // FileStream with FileShare.ReadWrite so the Cowire tailer can
                    // open the file concurrently without locking conflicts.
                    using (var fs = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite))
                    using (var sw = new StreamWriter(fs, new UTF8Encoding(false)))
                    {
                        sw.Write(line);
                        sw.Write('\n');
                    }
                }
            }
            catch (Exception ex)
            {
                // Last-ditch — never throw from these hooks; Unity will keep
                // calling them on subsequent compiles regardless.
                if (Thread.CurrentThread.ManagedThreadId == 1)
                {
                    Debug.LogWarning("[Cowire] event write failed: " + ex.Message);
                }
            }
        }

        private static void RotateIfTooBig(string path)
        {
            try
            {
                if (!File.Exists(path)) return;
                var info = new FileInfo(path);
                if (info.Length < RotateAtBytes) return;
                string backup = path + ".1";
                if (File.Exists(backup)) File.Delete(backup);
                File.Move(path, backup);
            }
            catch
            {
                /* not fatal */
            }
        }

        // Minimal JSON serializer — Unity's JsonUtility doesn't handle
        // Dictionary<string, object>, and pulling in Newtonsoft.Json forces a
        // package dependency the user may not want. ~40 lines is fine.
        private static string ToJson(Dictionary<string, object> obj)
        {
            var sb = new StringBuilder();
            sb.Append('{');
            bool first = true;
            foreach (var kv in obj)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append('"').Append(Escape(kv.Key)).Append("\":");
                AppendValue(sb, kv.Value);
            }
            sb.Append('}');
            return sb.ToString();
        }

        private static void AppendValue(StringBuilder sb, object v)
        {
            if (v == null) { sb.Append("null"); return; }
            switch (v)
            {
                case string s:
                    sb.Append('"').Append(Escape(s)).Append('"');
                    break;
                case bool b:
                    sb.Append(b ? "true" : "false");
                    break;
                case int i:
                    sb.Append(i);
                    break;
                case long l:
                    sb.Append(l);
                    break;
                case float f:
                    sb.Append(f.ToString(System.Globalization.CultureInfo.InvariantCulture));
                    break;
                case double d:
                    sb.Append(d.ToString(System.Globalization.CultureInfo.InvariantCulture));
                    break;
                default:
                    sb.Append('"').Append(Escape(v.ToString())).Append('"');
                    break;
            }
        }

        private static string Escape(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder(s.Length + 8);
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }
    }
}
#endif
