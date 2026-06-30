/**
 * Cure Chart Viewer — Google Apps Script Web App
 * Serves the client-side cure chart analysis tool as a web app.
 */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Cure Chart Viewer')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
