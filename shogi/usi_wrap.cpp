// ============================================================================
//  External USI wrapper (native binary) for the mozaic shogi engine.
// ----------------------------------------------------------------------------
//  For GUIs that can only register a single executable (e.g. ShogiHome): point
//  the GUI at THIS binary. It supplies what the stdio-only mozaic engine cannot:
//    1. Weight PERSISTENCE (file I/O): loads weights from a file at startup
//       (`loadweights`) and saves them after `train` (`dumpweights` -> file).
//    2. A transparent USI bridge between the GUI and the engine, on two pumps.
//  The mozaic engine itself stays pure-stdio; all file/GUI I/O lives here.
//
//  Paths are baked at compile time (-DENGINE_PATH / -DWEIGHTS_PATH) and may be
//  overridden at runtime via MZ_SHOGI_BIN / MZ_SHOGI_WEIGHTS.
//
//  Build:
//    clang++ -std=c++20 -O2 -pthread \
//      -DENGINE_PATH='"/abs/path/build/shogi"' \
//      -DWEIGHTS_PATH='"/abs/path/shogi/weights.txt"' \
//      -o build/shogi-usi shogi/usi_wrap.cpp
// ============================================================================
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <fstream>
#include <sstream>
#include <thread>
#include <unistd.h>
#include <sys/wait.h>

#ifndef ENGINE_PATH
#define ENGINE_PATH "build/shogi"
#endif
#ifndef WEIGHTS_PATH
#define WEIGHTS_PATH "weights.txt"
#endif

static std::string envOr(const char* k, const char* d) { const char* v = getenv(k); return v ? std::string(v) : std::string(d); }
static void rstrip(std::string& s) { while (!s.empty() && (s.back()=='\n'||s.back()=='\r'||s.back()==' '||s.back()=='\t')) s.pop_back(); }

int main() {
  const std::string engine  = envOr("MZ_SHOGI_BIN", ENGINE_PATH);
  const std::string weights = envOr("MZ_SHOGI_WEIGHTS", WEIGHTS_PATH);

  int toEng[2], fromEng[2];                 // toEng: parent->engine stdin ; fromEng: engine stdout->parent
  if (pipe(toEng) != 0 || pipe(fromEng) != 0) { perror("pipe"); return 1; }

  pid_t pid = fork();
  if (pid < 0) { perror("fork"); return 1; }
  if (pid == 0) {                           // ---- child: exec the engine ----
    dup2(toEng[0], STDIN_FILENO);
    dup2(fromEng[1], STDOUT_FILENO);
    close(toEng[0]); close(toEng[1]); close(fromEng[0]); close(fromEng[1]);
    execl(engine.c_str(), engine.c_str(), (char*)nullptr);
    fprintf(stderr, "info string [wrap] cannot exec engine '%s': %s\n", engine.c_str(), strerror(errno));
    _exit(127);
  }
  // ---- parent: bridge GUI <-> engine ----
  close(toEng[0]); close(fromEng[1]);
  FILE* engIn  = fdopen(toEng[1], "w");
  FILE* engOut = fdopen(fromEng[0], "r");
  auto sendLine = [&](const std::string& s) { fputs(s.c_str(), engIn); fputc('\n', engIn); fflush(engIn); };

  // Load persisted weights into the engine before any GUI traffic.
  {
    std::ifstream f(weights);
    if (f) {
      std::stringstream ss; ss << f.rdbuf();
      std::string data = ss.str(); rstrip(data);
      if (!data.empty()) { sendLine("loadweights " + data); fprintf(stderr, "info string [wrap] loaded weights <- %s\n", weights.c_str()); }
    } else {
      fprintf(stderr, "info string [wrap] no weights file (%s); run 'train' to create one\n", weights.c_str());
    }
  }

  // engine -> GUI pump. Intercept the `weights <count> <ints...>` dump: persist it, do NOT forward.
  std::thread pump([&] {
    char* line = nullptr; size_t cap = 0; ssize_t n;
    while ((n = getline(&line, &cap, engOut)) >= 0) {
      std::string s(line, (size_t)n); rstrip(s);
      if (s.rfind("weights ", 0) == 0) {
        size_t p1 = s.find(' ');                       // end of "weights"
        size_t p2 = (p1 == std::string::npos) ? p1 : s.find(' ', p1 + 1);  // end of count
        std::string ints = (p2 == std::string::npos) ? std::string() : s.substr(p2 + 1);
        std::ofstream of(weights); of << ints << "\n"; of.close();
        fprintf(stderr, "info string [wrap] saved weights -> %s\n", weights.c_str());
      } else {
        fputs(s.c_str(), stdout); fputc('\n', stdout); fflush(stdout);
      }
    }
    free(line);
  });

  // GUI -> engine (main thread). Pass through; after `train`, request a dump so the pump persists it.
  {
    char* line = nullptr; size_t cap = 0; ssize_t n;
    while ((n = getline(&line, &cap, stdin)) >= 0) {
      std::string s(line, (size_t)n); rstrip(s);
      sendLine(s);
      if (s == "train" || s == "selfplay") sendLine("dumpweights");   // persist learned weights
      if (s == "quit") break;
    }
    free(line);
  }

  fclose(engIn);                            // EOF on engine stdin -> engine exits its USI loop
  int st = 0; waitpid(pid, &st, 0);
  pump.join();                              // engOut hits EOF when the engine exits
  return 0;
}
