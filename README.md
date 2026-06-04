Key Features
Enhanced Reels Controller: YouTube-style timeline (seek bar), play/pause toggles, and duration tracking specifically for vertical videos.

Smart Memory: Automatically saves and applies your preferred volume and playback speed, solving the persistent auto-mute issue.

Performance Focused (Zero Jank): Implements a "scroll-settle" optimization that pauses UI operations during scrolling, ensuring a smooth and lag-free experience.

Easy Downloads:

Reels: Download watermark-free mp4 files directly using the Instagram Web API.

Feed Posts: Quick-download button that appears when hovering over photos.

HD Profile Pictures: Expands profile avatars to full resolution in a lightbox with a one-click download option.

Intelligent Detection: Automatically detects vertical content based on dimensions and injects controls seamlessly.

Installation
Ensure you have the Tampermonkey extension installed in your browser.

Click on the script.user.js file in this repository.

Tampermonkey will prompt you to install the script. Click Install.

Refresh your Instagram page to start using the controller.

Technical Details
Language: Pure Vanilla JavaScript (ES6+).

Zero Dependencies: No external libraries used; all UI components and styles are dynamically injected into the DOM (CSS-in-JS).

API Usage: Utilizes Instagram’s internal Web API endpoints (/api/v1/) to resolve high-quality media sources.

Important Notes
Account Requirement: Direct Reels downloading relies on your current session cookies. If downloading fails, ensure you are logged in.

Rate Limits: The script handles API requests efficiently, but be mindful that Instagram may impose temporary rate limits on excessive requests.

License
This project is licensed under the MIT License. Feel free to fork, modify, and contribute!
