import { useLayoutEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { animate } from 'motion';

gsap.registerPlugin(ScrollTrigger);

export function useLaunchScroll() {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const page = root.current!;
    const nav = page.querySelector('header.launch-nav')!;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let scrollAnimation: ReturnType<typeof animate> | undefined;
    let destination: HTMLElement | undefined;
    const stopScroll = () => { scrollAnimation?.stop(); scrollAnimation = undefined; destination = undefined; };
    function scrollTop(target: HTMLElement) {
      const offset = Math.max(nav.querySelector('.nav-inner')!.getBoundingClientRect().height + 12,
        parseFloat(getComputedStyle(target).scrollMarginTop) || 0);
      return Math.max(0, Math.min(target.getBoundingClientRect().top + window.scrollY - offset,
        document.documentElement.scrollHeight - window.innerHeight));
    }
    function focusTarget(target: HTMLElement) {
      if (!target.hasAttribute('tabindex')) {
        target.setAttribute('tabindex', '-1');
        target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
      }
      target.focus({ preventScroll: true });
    }
    function navigate(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element).closest<HTMLAnchorElement>('a[href^="#"]');
      if (!link || link.target || link.hasAttribute('download')) return;
      let id: string;
      try { id = decodeURIComponent(link.hash.slice(1)); } catch { return; }
      const target = document.getElementById(id);
      if (!target || !page.contains(target)) return;
      event.preventDefault();
      stopScroll();
      if (location.hash !== link.hash) history.pushState(history.state, '', link.hash);
      const end = scrollTop(target);
      if (reduced.matches || link.classList.contains('launch-skip')) {
        window.scrollTo({ top: end, behavior: 'instant' });
        focusTarget(target);
        return;
      }
      destination = target;
      scrollAnimation = animate(window.scrollY, end, {
        duration: Math.min(.85, .35 + Math.abs(end - window.scrollY) / 12000),
        ease: [.22, 1, .36, 1],
        onUpdate: top => window.scrollTo({ top, behavior: 'instant' }),
        onComplete: () => { destination = undefined; scrollAnimation = undefined; focusTarget(target); },
      });
    }
    const stopOnKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Tab', 'Escape'].includes(event.key)) stopScroll();
    };
    const reduceScroll = () => {
      const target = destination;
      if (!reduced.matches || !target) return;
      stopScroll();
      window.scrollTo({ top: scrollTop(target), behavior: 'instant' });
      focusTarget(target);
    };
    page.addEventListener('click', navigate);
    window.addEventListener('wheel', stopScroll, { passive: true });
    window.addEventListener('touchstart', stopScroll, { passive: true });
    window.addEventListener('pointerdown', stopScroll, { passive: true });
    window.addEventListener('keydown', stopOnKey);
    window.addEventListener('popstate', stopScroll);
    reduced.addEventListener('change', reduceScroll);
    const updateNav = () => nav.toggleAttribute('data-scrolled', window.scrollY > 8);
    window.addEventListener('scroll', updateNav, { passive: true });
    updateNav();
    const media = gsap.matchMedia(page);
    media.add({
      motion: '(prefers-reduced-motion: no-preference)',
      desktop: '(min-width: 721px)',
    }, context => {
      if (!context.conditions?.motion) return;
      const desktop = context.conditions.desktop;
      gsap.from('.launch-intro h1, .launch-intro > p, .launch-intro .launch-actions', {
        y: 18, opacity: 0, stagger: .11, duration: .7, ease: 'power2.out',
      });
      gsap.to('.launch-orbits', {
        y: desktop ? 100 : 32, ease: 'none',
        scrollTrigger: { trigger: page.querySelector('.launch-sky'), start: 'top top', end: 'bottom top', scrub: true },
      });

      // Measure the stationary section, so the frame's own transform cannot move its trigger.
      gsap.from('.launch-frame', {
        y: desktop ? 40 : 18,
        transformPerspective: 1100, transformOrigin: '50% 0%', ease: 'none',
        scrollTrigger: { trigger: page.querySelector('.launch-tour'), start: 'clamp(top bottom)', end: 'clamp(top 15%)', scrub: true },
      });

      page.querySelectorAll<HTMLElement>('[data-scroll-example]').forEach(example => {
        gsap.from(example, {
          y: desktop ? 30 : 14, opacity: .55, duration: .55, ease: 'power2.out',
          scrollTrigger: { trigger: example.parentElement, start: 'clamp(top 83%)', once: true },
        });
      });

    });

    // SPA rendering can finish after the browser's initial fragment navigation.
    const anchor = document.getElementById(window.location.hash.slice(1));
    if (anchor && page.contains(anchor) && window.scrollY === 0) anchor.scrollIntoView();
    return () => {
      stopScroll();
      page.removeEventListener('click', navigate);
      window.removeEventListener('wheel', stopScroll);
      window.removeEventListener('touchstart', stopScroll);
      window.removeEventListener('pointerdown', stopScroll);
      window.removeEventListener('keydown', stopOnKey);
      window.removeEventListener('popstate', stopScroll);
      reduced.removeEventListener('change', reduceScroll);
      window.removeEventListener('scroll', updateNav);
      media.revert();
    };
  }, []);
  return root;
}
