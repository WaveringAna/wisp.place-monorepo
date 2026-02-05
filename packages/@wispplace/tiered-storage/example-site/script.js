/**
 * Tiered Storage Demo Site - Client-side JavaScript
 *
 * This script demonstrates how a static site can interact with
 * the tiered storage system (in a real scenario, stats would be
 * fetched from a backend API that uses the storage library)
 */

// Simulated cache statistics
// In a real implementation, this would fetch from your backend
function simulateCacheStats() {
  return {
    hot: {
      items: 1,
      bytes: 3547,
      hits: 42,
      misses: 3,
    },
    warm: {
      items: 5,
      bytes: 127438,
      hits: 15,
      misses: 2,
    },
    cold: {
      items: 5,
      bytes: 127438,
    },
    totalHits: 57,
    totalMisses: 5,
    hitRate: 0.919,
  };
}

// Update stats display
function updateStatsDisplay() {
  const stats = simulateCacheStats();

  const hotItems = document.getElementById('hot-items');
  const warmItems = document.getElementById('warm-items');
  const coldItems = document.getElementById('cold-items');
  const hitRate = document.getElementById('hit-rate');

  if (hotItems) hotItems.textContent = stats.hot.items;
  if (warmItems) warmItems.textContent = stats.warm.items;
  if (coldItems) coldItems.textContent = stats.cold.items;
  if (hitRate) hitRate.textContent = `${(stats.hitRate * 100).toFixed(1)}%`;
}

// Smooth scrolling for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', function (e) {
    e.preventDefault();
    const target = document.querySelector(this.getAttribute('href'));
    if (target) {
      target.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
    }
  });
});

// Initialize stats when page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', updateStatsDisplay);
} else {
  updateStatsDisplay();
}

// Update stats periodically (simulate real-time updates)
setInterval(updateStatsDisplay, 5000);

// Add active class to navigation based on current page
const currentPage = window.location.pathname.split('/').pop() || 'index.html';
document.querySelectorAll('nav a').forEach(link => {
  if (link.getAttribute('href') === currentPage) {
    link.classList.add('active');
  }
});

// Log page view (in real app, would send to analytics)
console.log(`[TieredCache] Page viewed: ${currentPage}`);
console.log(`[TieredCache] This page was likely served from ${currentPage === 'index.html' ? 'hot tier (memory)' : 'warm tier (disk)'}`);
