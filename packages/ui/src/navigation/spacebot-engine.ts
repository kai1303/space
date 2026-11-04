// @ts-nocheck -- vendored, mechanically recovered pure geometry; typed public boundary below.
// Grokbots Studio public renderer, captured 2026-11-04. See spacebot-source.md.
// This module contains only local math/presets: no globals, network, DOM, eval or site bootstrap.
const definitions = [

    686495,
    813030,
    647609,
    (t) => {
      let e = 2 * Math.PI,
        i = (t, e = 0, i = 1) => (t < e ? e : t > i ? i : t);
      function a(t, i, r = 0) {
        let s = (t / i) * e;
        return (
          0.55 * Math.sin(s + r) +
          0.3 * Math.sin(2 * s + 1.7 * r + 1.1) +
          0.15 * Math.sin(3 * s + 2.3 * r + 2.4)
        );
      }
      function r(t) {
        let e = t >>> 0;
        return () => {
          let t = Math.imul((e = (e + 0x6d2b79f5) >>> 0) ^ (e >>> 15), 1 | e);
          return (
            (((t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t) ^ (t >>> 14)) >>>
              0) /
            0x100000000
          );
        };
      }
      let s = (t) => Math.round(100 * t) / 100;
      function l(t, e = 0.55, i = 0.62) {
        let a = ((t % 360) + 360) % 360,
          r = (1 - Math.abs(2 * i - 1)) * e,
          s = r * (1 - Math.abs(((a / 60) % 2) - 1)),
          h = i - r / 2,
          [n, o, p] =
            a < 60
              ? [r, s, 0]
              : a < 120
                ? [s, r, 0]
                : a < 180
                  ? [0, r, s]
                  : a < 240
                    ? [0, s, r]
                    : a < 300
                      ? [s, 0, r]
                      : [r, 0, s],
          u = (t) =>
            Math.round((t + h) * 255)
              .toString(16)
              .padStart(2, "0");
        return `#${u(n)}${u(o)}${u(p)}`;
      }
      t.s(
        [
          "Q",
          0,
          e,
          "O",
          0,
          i,
          "z",
          0,
          r,
          "X",
          0,
          {
            easeOutCubic: (t) => 1 - (1 - t) ** 3,
            easeInOutCubic: (t) =>
              t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2,
            easeOutQuint: (t) => 1 - (1 - t) ** 5,
          },
          "h",
          0,
          (t, e, i) => t + (e - t) * i,
          "i",
          0,
          a,
          "t",
          0,
          s,
        ],
        813030,
      );
      let h = r(659918),
        n = Array.from({ length: 6 }, (t, i) => ({
          a: 1.3 + 0.1 * h(),
          k: 0.05 + 0.4 * h(),
          tilt: (i / 6) * Math.PI + 0.5 * h(),
          speed: 3 + 0.7 * h(),
          phase: h() * e,
          sweep: 0.6 + 0.25 * h(),
          hue: (360 * i) / 6 + 30 * h(),
          hueSpan: 60 + 60 * h(),
          width: 0.05 + 0.012 * h(),
          cx: 0,
          cy: 0.1,
        })),
        o = Array.from({ length: 4 }, (t, e) => ({
          a: 0.78 + 0.2 * e,
          k: 0.05 + 0.02 * e,
          tilt: -0.62 + 0.05 * e,
          speed: 0.3,
          phase: 0.06 * e,
          sweep: 0.4,
          hue: 95 + 62 * e,
          hueSpan: 100,
          width: 0.05,
          cx: 0,
          cy: -0.12,
        })),
        p = r(48879),
        u = Array.from({ length: 5 }, (t, i) => ({
          birth: 0.2 * i,
          angle: p() * e,
          rho: 0.58 + 0.18 * p(),
        })),
        y = r(49383),
        c = Array.from({ length: 4 }, (t, e) => {
          let i = e - 1.5;
          return {
            a: 0.85 * (1 + 0.03 * i),
            k: (0.15 / 0.85) * (1 + 0.16 * i),
            tilt: (34 * Math.PI) / 180 + 0.035 * i,
            speed: 210 / 360,
            phase: -(0.045 * e) + 0.012 * y(),
            sweep: 0.34,
            hue: 85 * e + 20 * y(),
            hueSpan: 80,
            width: 0.095,
            cx: 0,
            cy: 0,
          };
        });
      t.s(
        [
          "E",
          0,
          0.129,
          "F",
          0,
          c,
          "p",
          0,
          1.25,
          "L",
          0,
          0.165,
          "j",
          0,
          [-0.557, -0.013, 0.532],
          "y",
          0,
          -42,
          "M",
          0,
          "#2496e8",
          "G",
          0,
          1.003,
          "f",
          0,
          0.054,
          "o",
          0,
          1.14,
          "K",
          0,
          0.15,
          "N",
          0,
          n,
          "Y",
          0,
          o,
          "c",
          0,
          function (t, i, a, r, h = 1) {
            let n = t.phase + i * t.speed * e,
              o = Math.cos(t.tilt),
              p = Math.sin(t.tilt),
              u = Math.sqrt(Math.max(0, 1 - t.k * t.k)),
              y = t.sweep * e,
              c = "",
              d = "",
              f = null;
            for (let e = 0; e <= 64; e++) {
              let i = n + (e / 64) * y,
                r = Math.cos(i),
                l = Math.sin(i),
                h = t.a * (r * o + -(l * p) * t.k) + t.cx,
                x = t.a * (r * p + l * o * t.k) + t.cy,
                M = t.a * l * u < 0,
                g = s(h * a),
                m = s(x * a),
                b = M !== f ? "M" : "L";
              (M ? (d += `${b}${g} ${m}`) : (c += `${b}${g} ${m}`), (f = M));
            }
            let x = Math.cos(t.tilt) * t.a * a,
              M = Math.sin(t.tilt) * t.a * a;
            return {
              id: r,
              front: c,
              back: d,
              width: t.width * a,
              opacity: h,
              grad: {
                x1: s(t.cx * a - x),
                y1: s(t.cy * a - M),
                x2: s(t.cx * a + x),
                y2: s(t.cy * a + M),
                stops: [
                  l(t.hue),
                  l(t.hue + 0.5 * t.hueSpan),
                  l(t.hue + t.hueSpan),
                ],
              },
            };
          },
          "q",
          0,
          function (t, e) {
            let a = [];
            for (let r of u) {
              let s = t - r.birth;
              if (s < 0 || s > 0.62) continue;
              let l = r.rho * Math.pow(0.75, 10 * s),
                h = r.angle + (100 * s * Math.PI) / 180;
              a.push({
                x: Math.cos(h) * l * e,
                y: Math.sin(h) * l * e,
                r: (0.04 + 0.028 * i(s / 0.55)) * e,
                depth: i(1 - l / 0.8),
                opacity: i(s / 0.06) * i((0.62 - s) / 0.08),
              });
            }
            return a;
          },
        ],
        686495,
      );
      let d = (t) => (t * Math.PI) / 180;
      function f(t, e, i) {
        let a = Math.cos(i),
          r = Math.sin(i);
        return [
          [t[0] * a + e[0] * r, t[1] * a + e[1] * r, t[2] * a + e[2] * r],
          [e[0] * a - t[0] * r, e[1] * a - t[1] * r, e[2] * a - t[2] * r],
        ];
      }
      let x = r(24301),
        M = (() => {
          let t = [],
            e = 1.4;
          for (; e < 900; )
            (t.push(e),
              (e += 1.9 + 2.7 * x()),
              0.18 > x() && (t.push(e), (e += 0.24)));
          return t;
        })();
      t.s(
        [
          "G",
          0,
          0.412,
          "B",
          0,
          15.46,
          "o",
          0,
          0.186,
          "K",
          0,
          { yaw: 28.49, pitch: 28.62, roll: -13 },
          "E",
          0,
          function (t) {
            return 0.06 + 0.94 * i(t);
          },
          "H",
          0,
          function (t, e, i = 15.46) {
            let a = [0, 0, 1],
              r = [1, 0, 0],
              s = [0, 1, 0];
            (([a, r] = f(a, r, d(t.yaw))),
              ([s, a] = f(s, a, d(t.pitch))),
              ([r, s] = f(r, s, d(t.roll))));
            let l = (t) => {
              let [l, h] = f(a, r, d(i * t));
              return {
                x: l[0] * e,
                y: l[1] * e,
                a: h[0],
                b: h[1],
                c: s[0],
                d: s[1],
                depth: l[2],
              };
            };
            return [l(-1), l(1)];
          },
          "f",
          0,
          function (t, e = {}) {
            let { wander: i = 1, blink: r = !0, float: s = !0 } = e;
            return {
              dYaw: (5.5 * a(t, 11.3, 0.4) + 1.6 * a(t, 3.7, 2.1)) * i,
              dPitch: (4.2 * a(t, 9.1, 1.3) + 1.3 * a(t, 4.3, 0.7)) * i,
              dRoll: 2.2 * a(t, 13.7, 3.2) * i,
              lid: r
                ? (function (t) {
                    for (let e = 0; e < M.length; e++) {
                      let i = M[e];
                      if (t < i) break;
                      let a = (t - i) / 0.18;
                      if (a >= 0 && a <= 1)
                        return a < 0.45 ? 1 - a / 0.45 : (a - 0.45) / 0.55;
                    }
                    return 1;
                  })(t)
                : 1,
              driftX: s ? 0.006 * a(t, 7.9, 1.9) : 0,
              driftY: s ? 0.007 * a(t, 5.3, 0.3) : 0,
              breath: s ? 1 + 0.005 * Math.sin((t / 3.4) * Math.PI * 2) : 1,
            };
          },
        ],
        647609,
      );
    },
    43307,
    166284,
    (t) => {
      var e = t.i(686495),
        i = t.i(769341),
        a = t.i(647609),
        r = t.i(266774),
        s = t.i(734648),
        l = t.i(556806);
      function h(t, e, i) {
        let s = [],
          l = (0, a.H)(t.gaze, 100, t.split);
        for (let a = 0; a < 2; a++) {
          let h = l[a];
          if (h.depth <= 0.02) continue;
          let n = t.eyes[a],
            o = ((n.tilt ?? 0) * Math.PI) / 180,
            p = Math.cos(o),
            u = Math.sin(o),
            y = h.a * p + h.c * u,
            c = h.b * p + h.d * u,
            d = -h.a * u + h.c * p,
            f = -h.b * u + h.d * p,
            x = Math.max(100 * n.w, 0.01) / 2,
            M = Math.max(100 * n.h, 0.01) / 2,
            g = Math.min(x, M),
            m = M > x,
            b = m ? M - g : x - g,
            w = (0, r._)(i, Math.atan2(h.y, h.x) - e.rot);
          s.push({
            x: h.x * w,
            y: h.y * w,
            ax: (m ? d : y) * b,
            ay: (m ? f : c) * b,
            r: g,
            m: [y, c, d, f],
          });
        }
        return s;
      }
      let n = 100 * Math.hypot(0.006, 0.007);
      function o(t, e, i, a) {
        let r = 1 / 0,
          s = 0,
          l = 0;
        for (let h of e) {
          let e = h.x + i,
            o = h.y + a,
            p = (function (t, e, i, a, r) {
              let s = a - e,
                l = r - i,
                h = s * s + l * l,
                n = 1 / 0,
                o = 0,
                p = 0;
              for (let a = 0; a < t.length; a++) {
                let r = t[a],
                  u = h > 0 ? ((r.x - e) * s + (r.y - i) * l) / h : 0,
                  y = e + (u = u < 0 ? 0 : u > 1 ? 1 : u) * s - r.x,
                  c = i + u * l - r.y,
                  d = y * y + c * c;
                d < n && ((n = d), (o = y), (p = c));
              }
              let u = Math.sqrt(n);
              return {
                d: u,
                ux: u > 1e-9 ? o / u : 0,
                uy: u > 1e-9 ? p / u : 0,
              };
            })(t, e - h.ax, o - h.ay, e + h.ax, o + h.ay),
            [u, y, c, d] = h.m,
            f = h.r * Math.hypot(u * p.ux + y * p.uy, c * p.ux + d * p.uy) + n;
          p.d - f < r && ((r = p.d - f), (s = p.ux), (l = p.uy));
        }
        return { marge: r, ux: s, uy: l };
      }
      let p = { x: 0, y: 0 },
        u = (t, e) => `${t}|${e ?? ""}`,
        y = new Map(
          s.p.map((t) => {
            let e = new Map();
            for (let a of l.W)
              if (a.baseBody)
                for (let s of a.baseFace ? [null, ...i.H] : [null])
                  e.set(
                    u(a.id, s?.id ?? null),
                    (function (t, e, i) {
                      let a,
                        s = [];
                      for (let l of (a = (t) =>
                        JSON.stringify([
                          t.gaze,
                          t.split,
                          t.eyes,
                          t.sil.rot,
                          t.sil.cx,
                          t.sil.cy,
                          t.sil.sx,
                          t.sil.sy,
                        ]))(t.pose(0)) === a(t.pose(t.duration))
                        ? [0]
                        : Array.from(
                            { length: 3 },
                            (e, i) => (i / 2) * t.duration,
                          )) {
                        let a = t.pose(l),
                          n = (0, r.Y)({ ...a.sil, radii: e }, 100),
                          o = (0, r.Y)(a.sil, 100),
                          p =
                            t.baseFace && i
                              ? { gaze: i.gaze, split: i.split, eyes: i.eyes }
                              : { gaze: a.gaze, split: a.split, eyes: a.eyes },
                          u = [];
                        for (let t of [-7.1, 7.1])
                          for (let e of [-5.5, 5.5])
                            u.push({
                              ...p,
                              gaze: {
                                yaw: p.gaze.yaw + t,
                                pitch: p.gaze.pitch + e,
                                roll: p.gaze.roll,
                              },
                            });
                        for (let t of u)
                          s.push({
                            empreintes: h(t, a.sil, e),
                            reference: h(t, a.sil, a.sil.radii),
                            contour: n,
                            calContour: o,
                          });
                      }
                      return (function (t) {
                        if (!t.length) return { x: 0, y: 0 };
                        let e = (e, i) => {
                            let a = 1 / 0;
                            for (let r of t)
                              a = Math.min(
                                a,
                                o(r.contour, r.empreintes, e, i).marge,
                              );
                            return a;
                          },
                          i = 1 / 0;
                        for (let e of t)
                          i = Math.min(
                            i,
                            o(e.calContour, e.reference, 0, 0).marge,
                          );
                        let a = 0,
                          r = 0,
                          s = t[0].empreintes;
                        for (let t of s)
                          ((a -= t.x / s.length), (r -= t.y / s.length));
                        let l = Math.max(35, 1.25 * Math.hypot(a, r));
                        i = Math.min(i, e(a, r));
                        let h = e(0, 0);
                        if (h >= i && h >= 0) return { x: 0, y: 0 };
                        let n = Math.max(i, 0),
                          p = 0,
                          u = 0,
                          y = 1 / 0,
                          c = 0,
                          d = 0,
                          f = h;
                        for (let t = 0; t < 12; t++) {
                          let i = (t / 12) * Math.PI * 2,
                            a = Math.cos(i),
                            r = Math.sin(i);
                          if (e(a * l, r * l) < n) {
                            for (let t of [0.3, 0.6, 1]) {
                              let i = e(a * l * t, r * l * t);
                              i > f &&
                                ((f = i), (c = a * l * t), (d = r * l * t));
                            }
                            continue;
                          }
                          let s = 0,
                            h = l;
                          for (let t = 0; t < 8; t++) {
                            let t = (s + h) / 2;
                            e(a * t, r * t) >= n ? (h = t) : (s = t);
                          }
                          h < y && ((y = h), (p = a * h), (u = r * h));
                        }
                        let x = 1 / 0 === y ? c : p,
                          M = 1 / 0 === y ? d : u;
                        return {
                          x: +(x / 100).toFixed(6),
                          y: +(M / 100).toFixed(6),
                        };
                      })(s);
                    })(a, t.radii, s),
                  );
            return [t.radii, e];
          }),
        );
      function c(t, e, i) {
        if (!t) return p;
        let a = y.get(t);
        return a ? (a.get(u(e, i)) ?? a.get(u(e, null)) ?? p) : p;
      }
      var d = t.i(813030);
      let f = { yaw: 0, pitch: 0, mix: 0, spin: 0, wander: 1 },
        x = (t, e, i) => ({
          w: (0, d.h)(t.w, e.w, i),
          h: (0, d.h)(t.h, e.h, i),
          open: (0, d.h)(t.open, e.open, i),
          tilt: (0, d.h)(t.tilt ?? 0, e.tilt ?? 0, i),
        });
      function M(t, e, i) {
        let a = 1 - i;
        return {
          sil: (0, r.m)(t.sil, e.sil, i),
          offX: (0, d.h)(t.offX, e.offX, i),
          offY: (0, d.h)(t.offY, e.offY, i),
          gaze: {
            yaw: (0, d.h)(t.gaze.yaw, e.gaze.yaw, i),
            pitch: (0, d.h)(t.gaze.pitch, e.gaze.pitch, i),
            roll: (0, d.h)(t.gaze.roll, e.gaze.roll, i),
          },
          split: (0, d.h)(t.split, e.split, i),
          eyes: [x(t.eyes[0], e.eyes[0], i), x(t.eyes[1], e.eyes[1], i)],
          eyeAlpha: (0, d.h)(t.eyeAlpha, e.eyeAlpha, i),
          bodyAlpha: (0, d.h)(t.bodyAlpha, e.bodyAlpha, i),
          dots: [
            ...t.dots.map((t) => ({ ...t, opacity: t.opacity * a })),
            ...e.dots.map((t) => ({ ...t, opacity: t.opacity * i })),
          ],
          arcs: [
            ...t.arcs.map((t) => ({
              ...t,
              id: `a${t.id}`,
              opacity: t.opacity * a,
            })),
            ...e.arcs.map((t) => ({
              ...t,
              id: `b${t.id}`,
              opacity: t.opacity * i,
            })),
          ],
          notif: i < 0.5 ? t.notif : e.notif,
          dotsBehind: i < 0.5 ? t.dotsBehind : e.dotsBehind,
        };
      }
      class g {
        scale;
        cur;
        prev = null;
        departFige = null;
        tCur = 0;
        tPrev = 0;
        blinkAt = -10;
        pts = [];
        shape = null;
        shapePrev = null;
        shapeAt = -10;
        expr = null;
        exprPrev = null;
        exprAt = -10;
        look = f;
        lookPrev = f;
        lookAt = -10;
        lookMorph = 0.24;
        static SHAPE_MORPH = 0.45;
        static LOOK_MORPH = 0.24;
        constructor(t = 100, e = "idle", i = null, a = null) {
          ((this.scale = t), (this.cur = e), (this.shape = i), (this.expr = a));
        }
        setExpression(t, e = 0) {
          t !== this.expr &&
            ((this.exprPrev = this.expr), (this.expr = t), (this.exprAt = e));
        }
        exprAtTime(t) {
          let e = this.expr,
            a = this.exprPrev;
          if (!e || !a) return e;
          let r = (t - this.exprAt) / g.SHAPE_MORPH;
          return r >= 1 ? e : (0, i.c)(a, e, d.X.easeOutQuint((0, d.O)(r)));
        }
        setShape(t, e = 0) {
          t !== this.shape &&
            ((this.shapePrev = this.shape),
            (this.shape = t),
            (this.shapeAt = e));
        }
        shapeAtTime(t) {
          let e = this.shape,
            i = this.shapePrev;
          if (!e || !i) return e;
          let a = (t - this.shapeAt) / g.SHAPE_MORPH;
          if (a >= 1) return e;
          let r = d.X.easeOutQuint((0, d.O)(a));
          return e.map((t, e) => (0, d.h)(i[e] ?? t, t, r));
        }
        setLook(t, e, i = g.LOOK_MORPH) {
          (!t ||
            Number.isFinite(t.yaw + t.pitch + t.mix + t.spin + t.wander)) &&
            ((this.lookPrev = this.lookAtTime(e)),
            (this.look = t ?? f),
            (this.lookAt = e),
            (this.lookMorph = i));
        }
        lookAtTime(t) {
          let e,
            i,
            a,
            r = (t - this.lookAt) / this.lookMorph;
          return r >= 1
            ? this.look
            : ((e = this.lookPrev),
              (i = this.look),
              (a = d.X.easeOutQuint((0, d.O)(r))),
              {
                yaw: (0, d.h)(e.yaw, i.yaw, a),
                pitch: (0, d.h)(e.pitch, i.pitch, a),
                mix: (0, d.h)(e.mix, i.mix, a),
                spin: (0, d.h)(e.spin, i.spin, a),
                wander: (0, d.h)(e.wander, i.wander, a),
              });
        }
        posed(t, e, i, a) {
          let r = t.pose(e);
          return (
            t.baseBody && i && (r = { ...r, sil: { ...r.sil, radii: i } }),
            t.baseFace &&
              a &&
              (r = { ...r, gaze: a.gaze, split: a.split, eyes: a.eyes }),
            r
          );
        }
        decalageAtTime(t, e) {
          let i = (e, i, a, r) => {
              if (a === r) return r;
              let s = (t - e) / i;
              if (s >= 1) return r;
              let l = d.X.easeOutQuint((0, d.O)(s));
              return { x: (0, d.h)(a.x, r.x, l), y: (0, d.h)(a.y, r.y, l) };
            },
            a = (t) =>
              i(
                this.exprAt,
                g.SHAPE_MORPH,
                c(t, e, this.exprPrev?.id ?? null),
                c(t, e, this.expr?.id ?? null),
              );
          return i(
            this.shapeAt,
            g.SHAPE_MORPH,
            a(this.shapePrev),
            a(this.shape),
          );
        }
        get state() {
          return this.cur;
        }
        reset(t, e) {
          ((this.cur = t),
            (this.prev = null),
            (this.departFige = null),
            (this.tCur = e),
            (this.tPrev = e),
            (this.blinkAt = -10));
        }
        origine(t, e, i) {
          if (this.departFige) return this.departFige;
          if (!this.prev) return null;
          let a = l.J.get(this.prev);
          return this.posed(a, Math.max(0, t - this.tPrev), e, i);
        }
        poseComposee(t) {
          let e = l.J.get(this.cur),
            i = this.shapeAtTime(t),
            a = this.exprAtTime(t),
            r = this.posed(e, Math.max(0, t - this.tCur), i, a),
            s = t - this.tCur;
          if (s >= e.morph) return r;
          let h = this.origine(t, i, a);
          return h ? M(h, r, d.X.easeOutQuint((0, d.O)(s / e.morph))) : r;
        }
        setState(t, e) {
          if (t === this.cur) return;
          let i = l.J.get(this.cur).morph,
            a = null !== this.prev && e - this.tCur < i;
          ((this.departFige = a ? this.poseComposee(e) : null),
            (this.prev = this.cur),
            (this.tPrev = this.tCur),
            (this.cur = t),
            (this.tCur = e),
            l.J.get(t)?.blinkIn && (this.blinkAt = e));
        }
        sample(t) {
          let i = this.scale,
            s = l.J.get(this.cur),
            h = this.shapeAtTime(t),
            n = this.exprAtTime(t),
            o = this.posed(s, Math.max(0, t - this.tCur), h, n),
            p = this.decalageAtTime(t, this.cur),
            u = t - this.tCur,
            y = u < s.morph ? this.origine(t, h, n) : null;
          if (y) {
            let e = d.X.easeOutQuint((0, d.O)(u / s.morph));
            o = M(y, o, e);
            let i = this.prev;
            if (i) {
              let a = this.decalageAtTime(t, i);
              p = { x: (0, d.h)(a.x, p.x, e), y: (0, d.h)(a.y, p.y, e) };
            }
          }
          let c = o.eyeAlpha > 0.01,
            f = this.lookAtTime(t),
            x = (0, a.f)(t, { wander: c ? f.wander : 0, blink: c }),
            g = {
              yaw: (0, d.h)(o.gaze.yaw, f.yaw, f.mix) + x.dYaw - f.spin,
              pitch: (0, d.h)(o.gaze.pitch, f.pitch, f.mix) + x.dPitch,
              roll: o.gaze.roll + x.dRoll,
            },
            m = (0, d.O)((t - this.blinkAt) / 0.2),
            b = m < 1 ? Math.abs(2 * m - 1) : 1,
            w = Math.min(x.lid, b),
            A = o.offX + x.driftX,
            O = o.offY + x.driftY,
            $ = {
              ...o.sil,
              cx: o.sil.cx + A,
              cy: o.sil.cy + O,
              sy: o.sil.sy * x.breath,
            },
            z = (0, r.y)((0, r.Y)($, i, this.pts)),
            P = (t, e) => (0, r._)(o.sil.radii, Math.atan2(e, t) - o.sil.rot),
            k = [];
          if (o.eyeAlpha > 0.01) {
            let t = (0, a.H)(g, i, o.split);
            for (let e = 0; e < 2; e++) {
              let s = t[e];
              if (s.depth <= 0.02) continue;
              let l = o.eyes[e],
                h = P(s.x, s.y),
                n = ((l.tilt ?? 0) * Math.PI) / 180,
                u = Math.cos(n),
                y = Math.sin(n),
                c = s.a * u + s.c * y,
                f = s.b * u + s.d * y,
                x = -s.a * y + s.c * u,
                M = -s.b * y + s.d * u,
                g = (0, a.E)(Math.min(w, l.open));
              k.push({
                d: (0, r.S)(l.w * i, l.h * i),
                matrix: `matrix(${(0, d.t)(c)},${(0, d.t)(f * g)},${(0, d.t)(x)},${(0, d.t)(M * g)},${(0, d.t)(s.x * h + (A + p.x) * i)},${(0, d.t)(s.y * h + (O + p.y) * i)})`,
                alpha: o.eyeAlpha * (0, d.O)(s.depth / 0.12),
              });
            }
          }
          let I = o.dots
              .filter((t) => t.opacity > 0.01 && t.r > 5e-4)
              .map((t) => ({
                ...t,
                x: (t.x + A) * i,
                y: (t.y + O) * i,
                r: t.r * i,
              })),
            v = o.notif ? P(o.notif.x, o.notif.y) : 1,
            B = o.notif ? (o.notif.x * v + A) * i : 0,
            F = o.notif ? (o.notif.y * v + O) * i : 0,
            Q = o.notif ? { x: B, y: F, r: o.notif.r * i } : null,
            X = o.notif ? { x: B, y: F, r: o.notif.notch * i } : null;
          return {
            bodyPath: z,
            bodyAlpha: o.bodyAlpha,
            eyes: k,
            dots: I,
            dotsBehind: o.dotsBehind,
            arcs: o.arcs
              .filter((t) => t.opacity > 0.01)
              .map((t) => (0, e.c)(t.seed, t.t, i, t.id, t.opacity)),
            notif: Q,
            notch: X,
          };
        }
      }
      (t.s(["f", 0, g], 43307), t.s(["J", 0, 158, "c", 0, 100], 166284));
    },
    769341,
    (t) => {
      var e = t.i(647609),
        i = t.i(813030);
      let a = (t, e, i = 0, a = 1) => ({ w: t, h: e, tilt: i, open: a }),
        r = (t, e, i = 0, r = 1) => [a(t, e, i, r), a(t, e, -i, r)],
        s = [
          {
            id: "neutre",
            gaze: { ...e.K },
            split: e.B,
            eyes: [a(e.o, e.G), a(e.o, e.G)],
          },
          {
            id: "attentif",
            gaze: { yaw: 4, pitch: 5, roll: -4 },
            split: 16,
            eyes: r(0.21, 0.44),
          },
          {
            id: "surpris",
            gaze: { yaw: 3, pitch: -3, roll: 0 },
            split: 19,
            eyes: r(0.45, 0.47),
          },
          {
            id: "excite",
            gaze: { yaw: 6, pitch: -14, roll: 0 },
            split: 19.5,
            eyes: r(0.4, 0.56, -10),
          },
          {
            id: "heureux",
            gaze: { yaw: 5, pitch: 9, roll: 0 },
            split: 17,
            eyes: r(0.27, 0.17, 14),
          },
          {
            id: "hilare",
            gaze: { yaw: 4, pitch: 14, roll: 0 },
            split: 18,
            eyes: r(0.34, 0.13, 20),
          },
          {
            id: "colere",
            gaze: { yaw: 3, pitch: 7, roll: 0 },
            split: 17,
            eyes: r(0.34, 0.15, 30),
          },
          {
            id: "triste",
            gaze: { yaw: 3, pitch: -13, roll: 0 },
            split: 16,
            eyes: r(0.22, 0.4, -28),
          },
          {
            id: "effraye",
            gaze: { yaw: 2, pitch: -20, roll: 0 },
            split: 20.5,
            eyes: r(0.4, 0.6),
          },
          {
            id: "mefiant",
            gaze: { yaw: 12, pitch: 6, roll: -6 },
            split: 16,
            eyes: [a(0.21, 0.4), a(0.22, 0.15)],
          },
          {
            id: "confus",
            gaze: { yaw: -14, pitch: 3, roll: 8 },
            split: 16.5,
            eyes: [a(0.2, 0.44, -18), a(0.28, 0.17, 14)],
          },
          {
            id: "curieux",
            gaze: { yaw: 16, pitch: -9, roll: -15 },
            split: 16.5,
            eyes: [a(0.24, 0.46, -8), a(0.2, 0.38, -8)],
          },
          {
            id: "fier",
            gaze: { yaw: 5, pitch: 17, roll: 0 },
            split: 17,
            eyes: r(0.3, 0.15, 18),
          },
          {
            id: "timide",
            gaze: { yaw: -19, pitch: -14, roll: -7 },
            split: 14,
            eyes: r(0.17, 0.3),
          },
          {
            id: "blase",
            gaze: { yaw: -22, pitch: 2, roll: 0 },
            split: 16,
            eyes: r(0.3, 0.12),
          },
          {
            id: "somnolent",
            gaze: { yaw: 6, pitch: -9, roll: -3 },
            split: 16,
            eyes: r(0.2, 0.42, 0, 0.42),
          },
        ],
        l = new Map(s.map((t) => [t.id, t])),
        h = (t, e, a) => ({
          w: (0, i.h)(t.w, e.w, a),
          h: (0, i.h)(t.h, e.h, a),
          tilt: (0, i.h)(t.tilt ?? 0, e.tilt ?? 0, a),
          open: (0, i.h)(t.open, e.open, a),
        });
      t.s([
        "H",
        0,
        s,
        "A",
        0,
        l,
        "c",
        0,
        function (t, e, a) {
          return {
            id: e.id,
            gaze: {
              yaw: (0, i.h)(t.gaze.yaw, e.gaze.yaw, a),
              pitch: (0, i.h)(t.gaze.pitch, e.gaze.pitch, a),
              roll: (0, i.h)(t.gaze.roll, e.gaze.roll, a),
            },
            split: (0, i.h)(t.split, e.split, a),
            eyes: [h(t.eyes[0], e.eyes[0], a), h(t.eyes[1], e.eyes[1], a)],
          };
        },
      ]);
    },
    266774,
    139539,
    (t) => {
      var e = t.i(813030);
      let i = {
        egg: [
          0.8369, 0.8424, 0.8497, 0.8585, 0.8674, 0.8775, 0.8878, 0.8983,
          0.9089, 0.9185, 0.9288, 0.9374, 0.9445, 0.9504, 0.9543, 0.9559,
          0.9555, 0.9519, 0.9466, 0.9389, 0.9302, 0.9193, 0.9085, 0.8969,
          0.8852, 0.8734, 0.8625, 0.8513, 0.8411, 0.8325, 0.8243, 0.8179,
          0.8137, 0.8112, 0.8102, 0.8128, 0.8178, 0.8262, 0.8374, 0.8518,
          0.8702, 0.8922, 0.9169, 0.9446, 0.9741, 1.0023, 1.0267, 1.0433,
          1.0481, 1.0393, 1.0216, 0.997, 0.9697, 0.9418, 0.9169, 0.8949, 0.876,
          0.8604, 0.849, 0.8394, 0.8337, 0.8314, 0.8305, 0.8326,
        ],
        hexagon: [
          0.921, 0.9282, 0.9441, 0.9706, 0.9984, 1.0059, 0.9896, 0.9562, 0.929,
          0.9124, 0.9047, 0.9058, 0.9157, 0.9349, 0.9642, 0.9873, 0.9882,
          0.9665, 0.9336, 0.9105, 0.8968, 0.8918, 0.8955, 0.908, 0.9293, 0.9611,
          0.982, 0.9812, 0.959, 0.9282, 0.9089, 0.8978, 0.8964, 0.9026, 0.9189,
          0.9439, 0.9778, 0.999, 0.9964, 0.9713, 0.9439, 0.9274, 0.9196, 0.9206,
          0.9308, 0.9502, 0.9799, 1.0121, 1.0226, 1.0071, 0.9752, 0.951, 0.9366,
          0.9316, 0.9351, 0.9485, 0.9711, 1.0026, 1.0213, 1.0155, 0.9863,
          0.9547, 0.9347, 0.9232,
        ],
        triangle: [
          0.7819, 0.8211, 0.8747, 0.944, 1.0223, 1.096, 1.1401, 1.134, 1.0808,
          1.0047, 0.9265, 0.8603, 0.8104, 0.773, 0.745, 0.7273, 0.7151, 0.7118,
          0.7148, 0.7245, 0.7427, 0.768, 0.8037, 0.8518, 0.9148, 0.9876, 1.0583,
          1.1073, 1.1109, 1.0667, 0.994, 0.9164, 0.8482, 0.7948, 0.7555, 0.7261,
          0.7056, 0.6925, 0.6859, 0.6869, 0.6938, 0.7084, 0.7305, 0.7615, 0.804,
          0.8595, 0.9311, 1.0092, 1.0791, 1.1171, 1.1054, 1.0501, 0.9779, 0.905,
          0.845, 0.799, 0.7656, 0.7413, 0.7258, 0.716, 0.7146, 0.7204, 0.733,
          0.7528,
        ],
      };
      t.s(["f", 0, i, "K", 0, 64], 139539);
      let a = Array.from({ length: 64 }, (t, i) => (i / 64) * e.Q),
        r = a.map(Math.cos),
        s = a.map(Math.sin);
      function l(t, e, i) {
        let a = Array(64).fill(0),
          l = t.length;
        for (let h = 0; h < 64; h++) {
          let n = r[h] ?? 0,
            o = s[h] ?? 0,
            p = 0;
          for (let a = 0; a < l; a++) {
            let r = t[a],
              s = t[(a + 1) % l],
              h = s.x - r.x,
              u = s.y - r.y,
              y = n * u - o * h;
            if (1e-9 > Math.abs(y)) continue;
            let c = r.x - e,
              d = r.y - i,
              f = (c * u - d * h) / y,
              x = (c * o - d * n) / y;
            f > p && x >= 0 && x <= 1 && (p = f);
          }
          a[h] = p;
        }
        return a;
      }
      t.s(
        [
          "m",
          0,
          function (t, i, a, r) {
            let s = r ?? {
              radii: Array(64),
              rot: 0,
              cx: 0,
              cy: 0,
              sx: 1,
              sy: 1,
            };
            for (let r = 0; r < 64; r++)
              s.radii[r] = (0, e.h)(t.radii[r] ?? 1, i.radii[r] ?? 1, a);
            let l = i.rot - t.rot;
            for (; l > Math.PI; ) l -= e.Q;
            for (; l < -Math.PI; ) l += e.Q;
            return (
              (s.rot = t.rot + l * a),
              (s.cx = (0, e.h)(t.cx, i.cx, a)),
              (s.cy = (0, e.h)(t.cy, i.cy, a)),
              (s.sx = (0, e.h)(t.sx, i.sx, a)),
              (s.sy = (0, e.h)(t.sy, i.sy, a)),
              s
            );
          },
          "S",
          0,
          function (t, i) {
            let a = Math.max(t, 0.01) / 2,
              r = Math.max(i, 0.01) / 2,
              s = Math.min(a, r);
            return `M${(0, e.t)(-a)} ${(0, e.t)(-r + s)}A${(0, e.t)(s)} ${(0, e.t)(s)} 0 0 1 ${(0, e.t)(-a + s)} ${(0, e.t)(-r)}L${(0, e.t)(a - s)} ${(0, e.t)(-r)}A${(0, e.t)(s)} ${(0, e.t)(s)} 0 0 1 ${(0, e.t)(a)} ${(0, e.t)(-r + s)}L${(0, e.t)(a)} ${(0, e.t)(r - s)}A${(0, e.t)(s)} ${(0, e.t)(s)} 0 0 1 ${(0, e.t)(a - s)} ${(0, e.t)(r)}L${(0, e.t)(-a + s)} ${(0, e.t)(r)}A${(0, e.t)(s)} ${(0, e.t)(s)} 0 0 1 ${(0, e.t)(-a)} ${(0, e.t)(r - s)}Z`;
          },
          "O",
          0,
          function (t, e = {}) {
            return {
              radii: Array(64).fill(t),
              rot: 0,
              cx: 0,
              cy: 0,
              sx: 1,
              sy: 1,
              ...e,
            };
          },
          "y",
          0,
          function (t, i = 1 / 6) {
            let a = t.length;
            if (a < 3) return "";
            let r = t[0],
              s = `M${(0, e.t)(r.x)} ${(0, e.t)(r.y)}`;
            for (let r = 0; r < a; r++) {
              let l = t[(r - 1 + a) % a],
                h = t[r],
                n = t[(r + 1) % a],
                o = t[(r + 2) % a],
                p = h.x + (n.x - l.x) * i,
                u = h.y + (n.y - l.y) * i,
                y = n.x - (o.x - h.x) * i,
                c = n.y - (o.y - h.y) * i;
              s += `C${(0, e.t)(p)} ${(0, e.t)(u)} ${(0, e.t)(y)} ${(0, e.t)(c)} ${(0, e.t)(n.x)} ${(0, e.t)(n.y)}`;
            }
            return `${s}Z`;
          },
          "K",
          0,
          function (t, i, a, r, s, l, h = 96) {
            let n = r - t,
              o = s - i,
              p = Math.hypot(n, o) || 1e-6,
              u = Math.atan2(o, n),
              y = Math.acos(Math.max(-1, Math.min(1, (a - l) / p))),
              c = [];
            for (let r = 0; r <= h / 2; r++) {
              let s = u + y + ((e.Q - 2 * y) * r) / (h / 2);
              c.push({ x: t + Math.cos(s) * a, y: i + Math.sin(s) * a });
            }
            for (let t = 0; t <= h / 2; t++) {
              let e = u - y + (2 * y * t) / (h / 2);
              c.push({ x: r + Math.cos(e) * l, y: s + Math.sin(e) * l });
            }
            return c;
          },
          "z",
          0,
          function (t, i = 1) {
            if (t.length < 3) return "";
            let a = "";
            for (let r = 0; r < t.length; r++) {
              let s = t[r];
              a += `${0 === r ? "M" : "L"}${(0, e.t)(s.x * i)} ${(0, e.t)(s.y * i)}`;
            }
            return `${a}Z`;
          },
          "t",
          0,
          l,
          "_",
          0,
          function (t, i) {
            let a = t.length,
              r = ((((i / e.Q) % 1) + 1) % 1) * a,
              s = Math.floor(r);
            return (0, e.h)(t[s % a] ?? 1, t[(s + 1) % a] ?? 1, r - s);
          },
          "U",
          0,
          function (t, i, a, r = 0) {
            let s = (r * Math.PI) / 180;
            return l(
              (function (t, i, a = 10) {
                let r = t.length,
                  s = [],
                  l = (t, e) => {
                    let i = e.x - t.x,
                      a = e.y - t.y,
                      r = Math.hypot(i, a) || 1;
                    return Math.atan2(-i / r, a / r);
                  };
                for (let h = 0; h < r; h++) {
                  let n = t[(h - 1 + r) % r],
                    o = t[h],
                    p = t[(h + 1) % r],
                    u = l(n, o),
                    y = l(o, p) - u;
                  for (; y > Math.PI; ) y -= e.Q;
                  for (; y < -Math.PI; ) y += e.Q;
                  for (let t = 0; t <= a; t++) {
                    let e = u + (y * t) / a;
                    s.push({
                      x: o.x + Math.cos(e) * i,
                      y: o.y + Math.sin(e) * i,
                    });
                  }
                }
                return s;
              })(
                Array.from({ length: t }, (r, l) => {
                  let h = s + (l / t) * e.Q;
                  return { x: Math.cos(h) * (i - a), y: Math.sin(h) * (i - a) };
                }),
                a,
              ),
              0,
              0,
            );
          },
          "$",
          0,
          function (t, e = {}) {
            return {
              radii: [...i[t]],
              rot: 0,
              cx: 0,
              cy: 0,
              sx: 1,
              sy: 1,
              ...e,
            };
          },
          "n",
          0,
          function (t, e = 1, i = 1) {
            return a.map((a, l) => {
              let h = Math.abs((r[l] ?? 0) / e) ** t,
                n = Math.abs((s[l] ?? 0) / i) ** t;
              return (h + n) ** (-1 / t);
            });
          },
          "Y",
          0,
          function (t, e, i = []) {
            let a = Math.cos(t.rot),
              l = Math.sin(t.rot);
            for (let h = 0; h < 64; h++) {
              let n = t.radii[h] ?? 1,
                o = n * (r[h] ?? 0),
                p = n * (s[h] ?? 0),
                u = o * a - p * l,
                y = o * l + p * a,
                c = i[h] ?? { x: 0, y: 0 };
              ((c.x = (u * t.sx + t.cx) * e),
                (c.y = (y * t.sy + t.cy) * e),
                (i[h] = c));
            }
            return ((i.length = 64), i);
          },
          "E",
          0,
          function (t) {
            let e = Array(64).fill(0);
            for (let i = 0; i < 64; i++) {
              let a = r[i] ?? 0,
                l = s[i] ?? 0,
                h = 0;
              for (let e of t) {
                let t = a * e.x + l * e.y,
                  i = t * t - (e.x * e.x + e.y * e.y - e.r * e.r);
                if (i < 0) continue;
                let r = t + Math.sqrt(i);
                r > h && (h = r);
              }
              e[i] = h;
            }
            return e;
          },
        ],
        266774,
      );
    },
    734648,
    (t) => {
      var e = t.i(139539),
        i = t.i(266774);
      function a(t, e = 1) {
        let i = Math.max(...t);
        if (i <= 0) return t;
        let r = e / i;
        return t.map((t) => t * r);
      }
      let r = a(
          Array.from({ length: e.K }, (t, i) => (i / e.K) * Math.PI * 2).map(
            (t) =>
              1 + 0.075 * Math.cos(2 * t + 0.5) + 0.035 * Math.cos(3 * t + 2.1),
          ),
          1.02,
        ),
        s = a(
          (0, i.E)([
            { x: -0.44, y: 0.2, r: 0.54 },
            { x: 0.46, y: 0.2, r: 0.5 },
            { x: 0.02, y: 0.3, r: 0.6 },
            { x: -0.24, y: -0.3, r: 0.48 },
            { x: 0.3, y: -0.24, r: 0.44 },
          ]),
          1.02,
        ),
        l = a((0, i.t)((0, i.K)(0, 0.28, 0.66, 0, -0.96, 0.05), 0, 0), 1.04),
        h = (0, i.t)((0, i.K)(-0.42, 0, 0.62, 0.42, 0, 0.62), 0, 0),
        n = [
          { id: "cercle", radii: Array(e.K).fill(1) },
          { id: "galet", radii: r },
          { id: "squircle", radii: a((0, i.n)(4.2), 1.15) },
          { id: "capsule", radii: h },
          { id: "triangle", radii: (0, i.U)(3, 1.12, 0.34, -90) },
          { id: "hexagone", radii: (0, i.U)(6, 1.04, 0.26, 0) },
          { id: "nuage", radii: s },
          { id: "goutte", radii: l },
        ],
        o = new Map(n.map((t) => [t.id, t])),
        p = [
          { id: "encre", hex: "#0a0a0c" },
          { id: "brun", hex: "#8b5e3c" },
          { id: "rouge", hex: "#e8483f" },
          { id: "orange", hex: "#f08a24" },
          { id: "ambre", hex: "#f0b429" },
          { id: "vert", hex: "#3ecf8e" },
          { id: "turquoise", hex: "#2fbfa0" },
          { id: "bleu", hex: "#3b93f0" },
          { id: "violet", hex: "#8b5cf6" },
          { id: "rose", hex: "#e152b0" },
          { id: "gris", hex: "#a3a3a3" },
          { id: "creme", hex: "#f1efe9" },
        ],
        u = new Map(p.map((t) => [t.id, t]));
      t.s([
        "F",
        0,
        p,
        "X",
        0,
        u,
        "p",
        0,
        n,
        "f",
        0,
        o,
        "j",
        0,
        function (t, e, i) {
          let a = (t) => {
              let e = parseInt(t.slice(1), 16);
              return [(e >> 16) & 255, (e >> 8) & 255, 255 & e];
            },
            r = a(t),
            s = a(e),
            l = r.map((t, e) => Math.round(t + (s[e] - t) * i));
          return `#${l.map((t) => t.toString(16).padStart(2, "0")).join("")}`;
        },
      ]);
    },
    556806,
    (t) => {
      var e = t.i(686495),
        i = t.i(647609),
        a = t.i(813030),
        r = t.i(266774);
      let s = (t, e) => [
        { w: t, h: e, open: 1 },
        { w: t, h: e, open: 1 },
      ];
      function l(t = {}) {
        return {
          sil: (0, r.O)(1),
          offX: 0,
          offY: 0,
          gaze: { ...i.K },
          split: i.B,
          eyes: s(i.o, i.G),
          eyeAlpha: 1,
          bodyAlpha: 1,
          dots: [],
          arcs: [],
          notif: null,
          dotsBehind: !1,
          ...t,
        };
      }
      let h = (0, r.t)((0, r.K)(0, -0.505, 0.132, 0, 0.13, 0.075), 0, -0.1875),
        n = (0, r.t)((0, r.K)(0, -0.2535, 0.1345, 0, 0.2535, 0.1345), 0, 0),
        o = (0, r.z)((0, r.K)(0, 0, 0.118, 0, 0.172, 0.012));
      function p(t) {
        return (0, r.$)("triangle", {
          rot: t,
          cx: -0.213 * Math.sin(t),
          cy: 0.213 * Math.cos(t),
        });
      }
      function u(t, e) {
        let i = ((((t - 0.5 * e) / 1.5) % 1) + 1) % 1,
          r = i < 0.5 ? 0.5 - 0.5 * Math.cos(i * a.Q) : 0;
        return (0, a.O)(2 * r);
      }
      let y = [
          {
            id: "idle",
            duration: 2.4,
            morph: 0.45,
            blinkIn: !1,
            baseFace: !0,
            baseBody: !0,
            pose: () => l(),
          },
          {
            id: "thinking",
            duration: 2.6,
            morph: 0.4,
            baseFace: !1,
            baseBody: !1,
            blinkIn: !0,
            pose: (t) => {
              let i = u(t, 1),
                s = 0.3 + 0.7 * a.X.easeOutCubic((0, a.O)(t / 0.3));
              return l({
                sil: (0, r.O)(e.L * (1 + (e.p - 1) * i), { cx: e.j[1] }),
                eyeAlpha: 0,
                dots: [0, 2].map((i) => {
                  let a = u(t, i);
                  return {
                    x: e.j[i] * s,
                    y: 0,
                    r: e.L * (1 + (e.p - 1) * a),
                    opacity: 0.55 + 0.45 * a,
                  };
                }),
              });
            },
          },
          {
            id: "wink",
            duration: 1.6,
            morph: 0.3,
            blinkIn: !0,
            baseFace: !1,
            baseBody: !0,
            pose: () =>
              l({
                gaze: { yaw: -5.37, pitch: 4.55, roll: 6.7 },
                split: 16.25,
                eyes: [
                  { w: 0.236, h: 0.464, open: 1 },
                  { w: 0.447, h: 0.089, open: 1 },
                ],
              }),
          },
          {
            id: "wide",
            duration: 1.8,
            morph: 0.55,
            blinkIn: !0,
            baseFace: !1,
            baseBody: !0,
            pose: () =>
              l({
                gaze: { yaw: 6.92, pitch: -21.96, roll: 11.6 },
                split: 18.43,
                eyes: s(0.356, 0.875),
              }),
          },
          {
            id: "alert",
            duration: 2.4,
            minDuration: 2,
            morph: 0.45,
            baseFace: !1,
            baseBody: !1,
            blinkIn: !1,
            pose: (t) => {
              let e = (0, a.O)(t / 1.5),
                i = 0.82 * a.X.easeInOutCubic(e) - 0.087,
                r = t > 1.6 ? (0, a.O)((t - 1.6) / 0.4) : 0,
                s = i * (1 - r) + 0.1 * r,
                h = 0.005 * Math.sin(2.5 * t * a.Q),
                p = (17.7 * Math.PI) / 180;
              return l({
                sil: ((t = {}) => ({
                  radii: [...n],
                  rot: 0,
                  cx: 0,
                  cy: 0,
                  sx: 1,
                  sy: 1,
                  ...t,
                }))({ rot: p, cx: s, cy: -0.325 - h }),
                eyeAlpha: 0,
                dots: [
                  {
                    x: s - 0.58 * Math.sin(p),
                    y: -0.325 + 0.58 * Math.cos(p) + 2.8 * h,
                    r: 0.118,
                    d: o,
                    rot: (180 * p) / Math.PI,
                    opacity: 1,
                  },
                ],
              });
            },
          },
          {
            id: "notify",
            duration: 2.2,
            morph: 0.5,
            blinkIn: !0,
            baseFace: !1,
            baseBody: !0,
            pose: (t) => {
              let i = (0, a.O)(t / 0.45),
                r = 1 + (e.o - 1) * Math.sin(i * Math.PI) * (1 - 0.35 * i),
                h = e.K * (i < 1 ? r : 1),
                n = (e.y * Math.PI) / 180;
              return l({
                gaze: { yaw: -21.94, pitch: -5.82, roll: -12.2 },
                split: 18.89,
                eyes: s(0.505, 0.498),
                notif: {
                  x: Math.cos(n) * e.G,
                  y: Math.sin(n) * e.G,
                  r: h,
                  notch: h + e.f,
                },
              });
            },
          },
          {
            id: "exclaim",
            duration: 2,
            morph: 0.45,
            baseFace: !1,
            baseBody: !1,
            blinkIn: !1,
            pose: () =>
              l({
                sil: ((t = {}) => ({
                  radii: [...h],
                  rot: 0,
                  cx: 0,
                  cy: -0.1875,
                  sx: 1,
                  sy: 1,
                  ...t,
                }))(),
                eyeAlpha: 0,
                dots: [{ x: -0.012, y: 0.526, r: 0.113, opacity: 1 }],
              }),
          },
          {
            id: "sleep",
            duration: 2.4,
            morph: 0.5,
            baseFace: !1,
            baseBody: !1,
            blinkIn: !1,
            pose: (t) =>
              l({
                sil: (0, r.O)(0.1585, {
                  cy: 0.11 + 0.19 * Math.sin(t * (a.Q / 0.6)),
                }),
                eyeAlpha: 0,
              }),
          },
          {
            id: "egg",
            duration: 1.8,
            morph: 0.4,
            baseFace: !1,
            baseBody: !1,
            blinkIn: !0,
            pose: () =>
              l({
                sil: (0, r.$)("egg"),
                gaze: { yaw: 19.97, pitch: 26.01, roll: -17.1 },
                split: 11.07,
                eyes: s(0.164, 0.385),
              }),
          },
          {
            id: "hexagon",
            duration: 1.6,
            morph: 0.4,
            baseFace: !1,
            baseBody: !1,
            blinkIn: !0,
            pose: () =>
              l({
                sil: (0, r.$)("hexagon"),
                gaze: { yaw: 23.11, pitch: 24.42, roll: -13.3 },
                split: 13.37,
                eyes: s(0.177, 0.411),
              }),
          },
          {
            id: "play",
            duration: 2,
            morph: 0.5,
            baseFace: !1,
            baseBody: !1,
            blinkIn: !0,
            pose: (t) => {
              let i = (0, a.O)(t / 0.35) * (0, a.O)((2.2 - t) / 0.5);
              return l({
                sil: p(0),
                gaze: { yaw: 12, pitch: -8, roll: -6 },
                split: 15,
                eyes: s(0.18, 0.34),
                arcs: e.Y.map((e, a) => ({
                  id: `sw${a}`,
                  seed: { ...e, cx: 0.45 - 0.42 * t },
                  t,
                  opacity: i,
                })),
              });
            },
          },
          {
            id: "orbit",
            duration: 3.4,
            minDuration: 2.5,
            morph: 0.6,
            baseFace: !1,
            baseBody: !1,
            blinkIn: !1,
            pose: (t) => {
              let h = a.X.easeInOutCubic((0, a.O)(t / 0.35)),
                n = -(1.25 * a.Q) * t * h,
                o = a.X.easeInOutCubic((0, a.O)((t - 1.6) / 0.9)),
                u = p(n),
                y = (0, r.O)(1, { rot: n }),
                c = {
                  radii: u.radii.map((t, e) => t + (y.radii[e] - t) * o),
                  rot: n,
                  cx: u.cx * (1 - o),
                  cy: u.cy * (1 - o),
                  sx: 1,
                  sy: 1,
                },
                d = (0, a.O)(t / 0.8) * (0, a.O)((3.6 - t) / 0.9);
              return l({
                sil: c,
                gaze: {
                  yaw: i.K.yaw + 65 * Math.sin(6.5 * t) * (1 - o),
                  pitch: -4 + 32 * o,
                  roll: -13,
                },
                eyes: s(0.18, 0.34 + 0.07 * o),
                arcs: e.N.map((e, i) => ({
                  id: `rg${i}`,
                  seed: e,
                  t,
                  opacity: d * (0, a.O)((t - 0.13 * i) / 0.3),
                })),
              });
            },
          },
          {
            id: "swirl",
            duration: 1.3,
            minDuration: 1.3,
            morph: 0.3,
            baseFace: !0,
            baseBody: !0,
            blinkIn: !0,
            pose: (t) =>
              l({
                arcs: e.N.slice(0, 3).map((e, i) => ({
                  id: `sw${i}`,
                  seed: e,
                  t,
                  opacity:
                    (0, a.O)((t - 0.06 * i) / 0.14) *
                    (0, a.O)((1.22 - t) / 0.34),
                })),
              }),
          },
          {
            id: "burst",
            duration: 2.6,
            minDuration: 2.4,
            morph: 0.4,
            baseFace: !1,
            baseBody: !1,
            blinkIn: !1,
            pose: (t) => {
              let i = 1 - 0.834 * a.X.easeOutQuint((0, a.O)(t / 0.7)),
                s = a.X.easeOutQuint((0, a.O)((t - 1.7) / 0.7));
              return l({
                sil: (0, r.O)(i + (1 - i) * s),
                eyeAlpha: (0, a.O)((t - 1.85) / 0.4),
                dots: (0, e.q)(t, 1),
                dotsBehind: !0,
              });
            },
          },
          {
            id: "comet",
            duration: 2.4,
            minDuration: 2.4,
            morph: 0.45,
            baseFace: !1,
            baseBody: !1,
            blinkIn: !1,
            pose: (t) => {
              let i = 1 - (1 - e.E) * a.X.easeOutQuint((0, a.O)(t / 0.55)),
                s = a.X.easeOutQuint((0, a.O)((t - 1.85) / 0.6)),
                h = (0, a.O)((t - 0.15) / 0.25) * (0, a.O)((1.95 - t) / 0.3);
              return l({
                sil: (0, r.O)(i + (1 - i) * s, {
                  cy: 0.035 * Math.sin((0, a.O)(t / 1.7) * Math.PI),
                }),
                eyeAlpha: (0, a.O)((t - 2) / 0.35),
                arcs: e.F.map((e, i) => ({
                  id: `cm${i}`,
                  seed: e,
                  t,
                  opacity: h,
                })),
              });
            },
          },
        ],
        c = new Map(y.map((t) => [t.id, t]));
      t.s([
        "o",
        0,
        {
          idle: 1,
          thinking: 1.1,
          wink: 0.8,
          wide: 0.8,
          alert: 0.75,
          notify: 0.9,
          exclaim: 0.8,
          sleep: 0.45,
          egg: 0.8,
          hexagon: 0.8,
          play: 0.9,
          orbit: 1.2,
          swirl: 0.5,
          burst: 0.45,
          comet: 1.15,
        },
        "W",
        0,
        y,
        "J",
        0,
        c,
      ]);
    },
  ];
const factories = new Map(), values = new Map();
let ids = [];
for (const entry of definitions) {
 if (typeof entry === 'number') ids.push(entry);
 else {
  const group = { ids, run: entry, initialized: false };
  for (const id of ids) factories.set(id, group);
  ids = [];
 }
}
function load(id) {
 const group = factories.get(id);
 if (!group) throw new Error(`Missing local avatar geometry ${id}`);
 if (!group.initialized) {
  group.initialized = true;
  group.run({i:load,s(entries,target=group.ids[0]) {
   const exports = values.get(target) ?? {};
   for (let index=0;index<entries.length;index+=3) exports[entries[index]]=entries[index+2];
   values.set(target,exports);
  }});
 }
 return values.get(id);
}
export type BotState = 'idle'|'thinking'|'wink'|'wide'|'alert'|'notify'|'exclaim'|'sleep'|'egg'|'hexagon'|'play'|'orbit'|'swirl'|'burst'|'comet';
export type Shape = {id:string;radii:number[]};
export type Expression = {id:string;gaze:{yaw:number;pitch:number;roll:number};split:number;eyes:{w:number;h:number;tilt?:number;open:number}[]};
export type Dot = {x:number;y:number;r:number;opacity:number;color?:string;depth?:number;d?:string;rot?:number};
export type Arc = {id:string;back:string;front:string;width:number;opacity:number;grad:{x1:number;y1:number;x2:number;y2:number;stops:string[]}};
export type BotFrame = {bodyPath:string;bodyAlpha:number;eyes:{d:string;matrix:string;alpha:number}[];dots:Dot[];dotsBehind:boolean;arcs:Arc[];notif:{x:number;y:number;r:number}|null;notch:{x:number;y:number;r:number}|null};
export type Look = {yaw:number;pitch:number;mix:number;spin:number;wander:number};
export interface Engine {
 readonly state:BotState;
 setShape(shape:number[]|null,time:number):void;
 setExpression(expression:Expression|null,time:number):void;
 setLook(look:Look|null,time:number,duration?:number):void;
 setState(state:BotState,time:number):void;
 sample(time:number):BotFrame;
}
export const BotEngine = load(43307).f as new(scale?:number,state?:BotState,shape?:number[]|null,expression?:Expression|null)=>Engine;
export const shapes = load(734648).p as Shape[];
export const expressions = load(769341).H as Expression[];
export const states = load(556806).W as {id:BotState;duration:number;minDuration?:number;morph:number}[];
export const frozenAt = load(556806).o as Record<BotState,number>;
const maxMorph = Math.max(...states.map(state=>state.morph));
export function poseDuration(state:BotState):number {const preset=states.find(item=>item.id===state);return Math.max(maxMorph,preset?.minDuration??preset?.duration??2);}
export const mixColor = load(734648).j as (from:string,to:string,mix:number)=>string;
export const notificationColor = load(686495).M as string;
