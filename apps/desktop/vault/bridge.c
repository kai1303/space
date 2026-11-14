// Called exclusively by Electron's main thread. The callback only reports a close/save.
#include <node_api.h>
#include <stdint.h>
#include <stdbool.h>
#include <string.h>
#include <stdlib.h>

extern void *space_vault_attach(void *, const char *, const char *, const char *, bool, bool, void *, void (*)(void *, int32_t));
extern void space_vault_detach(void *);

typedef struct {
    void *session;
    napi_threadsafe_function callback;
} Presentation;

static void deliver(napi_env env, napi_value callback, void *context, void *result) {
    if (!env || !callback) return;
    napi_value status, receiver;
    napi_create_int32(env, (int32_t)(intptr_t)result, &status);
    napi_get_undefined(env, &receiver);
    napi_call_function(env, receiver, callback, 1, &status, NULL);
}

static void finished(void *context, int32_t status) {
    Presentation *p = context;
    napi_call_threadsafe_function(p->callback, (void *)(intptr_t)status, napi_tsfn_nonblocking);
    napi_release_threadsafe_function(p->callback, napi_tsfn_release);
}

static void detach(Presentation *p) {
    if (p->session) {
        space_vault_detach(p->session);
        p->session = NULL;
    }
}

static void finalize(napi_env env, void *data, void *hint) {
    Presentation *p = data;
    detach(p);
    free(p);
}

static bool string_arg(napi_env env, napi_value value, char *out, size_t capacity) {
    size_t bytes;
    return napi_get_value_string_utf8(env, value, NULL, 0, &bytes) == napi_ok && bytes < capacity &&
           napi_get_value_string_utf8(env, value, out, capacity, NULL) == napi_ok;
}

static napi_value open_vault(napi_env env, napi_callback_info info) {
    size_t argc = 7, length;
    napi_value args[7], name, handle;
    void *buffer, *view;
    bool setup, dark;
    char scope[65], site[8193], endpoint[2049];
    napi_get_cb_info(env, info, &argc, args, NULL, NULL);
    if (argc != 7 || napi_get_buffer_info(env, args[0], &buffer, &length) != napi_ok || length != sizeof(view) ||
        !string_arg(env, args[1], scope, sizeof(scope)) || strlen(scope) != 64 ||
        !string_arg(env, args[2], site, sizeof(site)) || !string_arg(env, args[3], endpoint, sizeof(endpoint)) ||
        napi_get_value_bool(env, args[4], &setup) != napi_ok || napi_get_value_bool(env, args[5], &dark) != napi_ok) goto error;
    memcpy(&view, buffer, sizeof(view));
    if (!view) goto error;
    Presentation *p = calloc(1, sizeof(*p));
    if (!p) goto error;
    if (napi_create_external(env, p, finalize, NULL, &handle) != napi_ok) { free(p); goto error; }
    napi_create_string_utf8(env, "Space Vault", NAPI_AUTO_LENGTH, &name);
    if (napi_create_threadsafe_function(env, args[6], NULL, name, 1, 1, NULL, NULL, NULL, deliver, &p->callback) != napi_ok) goto error;
    p->session = space_vault_attach(view, scope, site, endpoint, setup, dark, p, finished);
    if (!p->session) {
        napi_release_threadsafe_function(p->callback, napi_tsfn_abort);
        goto error;
    }
    return handle;
error:
    napi_throw_error(env, NULL, "Cannot attach the personal Vault.");
    return NULL;
}

static napi_value close_vault(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value handle;
    void *p;
    napi_get_cb_info(env, info, &argc, &handle, NULL, NULL);
    if (argc == 1 && napi_get_value_external(env, handle, &p) == napi_ok) detach(p);
    return NULL;
}

NAPI_MODULE_INIT() {
    napi_property_descriptor methods[] = {
        {"open", NULL, open_vault, NULL, NULL, NULL, napi_default, NULL},
        {"close", NULL, close_vault, NULL, NULL, NULL, napi_default, NULL}
    };
    napi_define_properties(env, exports, 2, methods);
    return exports;
}
