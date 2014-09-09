// an example AcServer script
// the script must call context.send to finish it's exectution

module.exports = function(context) {
	return context.send(200, 'hello script says hello from ' + context.request.url);
}