#!/bin/sh
# This script calls nodejs with a js file of the same name
BASENAME="$( basename "$0" .sh)"
BASEDIR="$( cd "$( dirname "$0" )" && pwd )"
nodejs ${BASEDIR}/${BASENAME}.js "$@"
