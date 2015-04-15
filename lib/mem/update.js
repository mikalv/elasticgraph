/**
{
  force:true,//Whether to force creation of nested path if it does not fully exist
  update: {
    set:[
      { 
        _path: ["arr1",{y:{x:{'>':3},f:{'<=':5}},z:23},"arr2",{a:2,f:4},"x"],
        _value : 6.5
      },
      {
        key:a//edge a
      },
      {//aray with prorties x=4,y=8
        x:4,
        y:8       
      }
    ],
    pull:[
      {
        yy:6.5
      },
      {
        arr1:{y:23,z:32}
      }
    ],
    push:[
      {
        y:5
      },
      {
        arr_z:{answer:"42"}
      },
      {//For nested path through arrays 
        _path: ["arr1",{y:{'=':{x:{'>':3}},f:{'<=':5}},z:23},"arr2",{a:2,f:4},"x"],
        _value : 6.5
      }
    ]
  }
  
}

*/
//var longjon = require('longjohn')
var get = require('./get')
module.exports = function(params, config) {
  var doc = params.doc
  if(!doc)
    throw new Error("update is missing the 'doc' parameter")
  var update = params.update
  if(!update) 
    return 
  var force = params.force || true
  var operations = Object.keys(update)
  if(!operations)
    return

  for(var i in operations) { 
    var operation = operations[i]
    //execute the operation, whether $push or $pull with its parameters
    var op_params = update[operation]
    if(op_params instanceof Array){
      for(var i=0;i<op_params.length;i++) 
        module.exports[operation](doc,op_params[i],force)
    } else if(op_params instanceof Object){
      module.exports[operation](doc,op_params, force)
    } else 
      throw new Error("update param must be Array of instructions OR a single instruction Object")
  }
} 
/** 
  { 
    _path: ["arr1",{y:{x:{'>':3},f:{'<=':5}},z:23},"arr2",{a:2,f:4},"x"],
    _value : 6.5
  }
   @param doc
   @param params They can come in two forms
        {nested,value} : The nested path of keys will be traversed within the doc to set the value at leaf
        (attrs} : All the attributes in attrs Object are directly copied to doc 
 */
var set = function(doc,params,force){
    
  if(params._path) {//is array of keys (path) to traverse depth wise in the doc
    var keys = params._path
    var nested = get.last_parent(doc,keys,force)
    var last_key = keys[keys.length -1].key
    nested[last_key] = params._value
  } else {//is (potentially multiple) attributes to copy
    var keys = Object.keys(params)
    for(var i in keys) 
      doc[keys[i]]= params[keys[i]]
  }
  return doc
}
/**
 * @param doc the doc to be updated
 * @param params Of three kinds
 *  {_path,value} //The value to be ushed at nested path
 *  {_path,values}//Each value in values is pushed
 *  {attrs}//Key value pairs to be directly set
 */
var push = function(doc,params,force) {
  if(params._path) {
    var keys = params._path
    var nested = get.last_parent(doc,keys,force)
    var last_key = keys[keys.length -1].key || keys[keys.length -1]
    if(!nested[last_key])
      nested[last_key] = []
    if(params._value)//Push the single element
      nested[last_key].push(params._value)
    else if (params._values) {//Push the array of elements
      for(var i in params._values) {
        nested[last_key].push(params._values[i])
      }
    }
  } else { //These are single depth keys/attrs to be set in the doc
    pushAttrs(doc,params)
  }
  return doc
}

var pushAttrs = function(doc, attrs) {
  var keys = Object.keys(attrs)
  for(var i in keys) {
    if(!doc[keys[i]])
      doc[keys[i]] = []
    doc[keys[i]].push(attrs[keys[i]])
  }
}
//EXPORTS
module.exports.push = push
module.exports.set = set
//END OF EXPORTS
if(require.main === module) {
  console.log(
    JSON.stringify(
      set(
        [{a:3,b:4},{c:3,b:5,d:{f:[{a:2},{a:3,b:{v:2}}]}}],
        {
          _path:[{b:5},{'key':'d'},{'key':'f'},{'a':3},{'key':'z'}],
          value:1
        }
      )
    )
  )
}
//console.log(JSON.stringify(push([{a:3,b:4},{c:3,b:5,d:{f:[{a:2},{a:3,b:{v:2}}]}}],{_path:[{b:5},'d','f',{a:3},'c'],values:[2,3]})))
//console.log(set({x:2},{x:5}))
//console.log(set({x:{y:2,g:{}}},{_path:['x','g','h'],value:3}))
//console.log(JSON.stringify(push({x:{y:2,g:{}}},{_path:['x','g','h'],values:[3,2]})))
//console.log(push({x:{y:2,g:[]}},{_path:['x','g'],value:3}))